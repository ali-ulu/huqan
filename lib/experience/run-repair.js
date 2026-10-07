'use strict';

/**
 * The bounded repair loop in a real AgentV3 run (#3151, owner decision
 * 2026-09-29: "run it automatically once it is approved").
 *
 * `lib/experience/repair.js` plans a repair as pure data; this module is the
 * runtime seam that planner was waiting for.
 *
 * 1. **Propose.** A step that failed transiently (the same classification the
 *    in-run retry uses) and exhausted its in-run retries gets a plan from
 *    `planRepair`. Permanent failures and policy blocks are never repaired,
 *    and an exhausted budget proposes nothing. The plan becomes:
 *    - a repair step with its own id (`<stepId>~repair<n>`), so its attempt,
 *      invocation and effect-ledger identities are fresh;
 *    - a pending approval (`huqan.agent_repair`) that an operator decides
 *      like any other (`onayla <id> approved`);
 *    - a `repair_proposed` event caused by the failed attempt;
 *    - a paused run whose checkpoint keeps the repair step queued.
 * 2. **Approve, then run.** Approving the record resumes the run through the
 *    approval executor (`../mcp-agent-repair-execution.js`) with no further
 *    human step. The run executes the repair step only if the stored approval
 *    for exactly this repair is approved or executing: a caller that merely
 *    names an approval id proves nothing. A rejected repair is dropped.
 * 3. **Record.** After the repair step ran, `repair_executed` carries its
 *    attempt, the approval that allowed it and how it went.
 *
 * The repair budget (`attemptsUsed` per step) lives in the run state and so
 * in the checkpoint: a crash cannot reset it. The plan's backoff is recorded,
 * not slept: the approval is the wait.
 */

const { createRepairPolicy, FAILURE_KINDS } = require('./repair');
const { isTransientStepReport } = require('../agent-step-executor');
const { EVENT_TYPES, EXECUTION_STATUSES, checkRepair } = require('./contract');
const { AGENT_PAUSE_REASONS } = require('../agent-exit-reasons');

const REPAIR_TOOL = 'huqan.agent_repair';
const REPAIR_PAUSE = AGENT_PAUSE_REASONS.REPAIR_PENDING_APPROVAL;
const EXECUTABLE_STATUSES = Object.freeze(['approved', 'executing']);

function journalOf(agent) {
  const base = agent && agent.baseAgent;
  return (base && base.experienceJournal) || (agent && agent.kernel && agent.kernel.experienceJournal) || null;
}

function appendSafely(journal, event) {
  if (!journal || typeof journal.append !== 'function') return null;
  try {
    return journal.append(event);
  } catch (_) {
    return null;
  }
}

function runIdOf(state) {
  return state && (state.runId || state.observabilityRunId) ? String(state.runId || state.observabilityRunId) : null;
}

/** The failed attempt's terminal event, read from the journal so the proposal
 * points at what actually happened rather than a guessed attempt number. */
function lastTerminalEvent(journal, runId, stepId, workspaceId) {
  if (!journal || typeof journal.read !== 'function') return null;
  let events = [];
  try {
    events = journal.read(runId, { workspaceId }) || [];
  } catch (_) {
    return null;
  }
  const invocationId = `${runId}:step:${stepId}`;
  const terminal = events.filter((event) => event.invocationId === invocationId
    && (event.type === EVENT_TYPES.EXECUTION_FINISHED || event.type === EVENT_TYPES.FAILURE));
  return terminal.length ? terminal[terminal.length - 1] : null;
}

function baseStepId(step) {
  const id = String(step.id || '');
  const at = id.indexOf('~repair');
  return at >= 0 ? id.slice(0, at) : id;
}

/**
 * Propose a repair for a step that just failed. Returns the repair step to
 * queue, or null when no repair is proposed (not transient, not a failure,
 * budget exhausted, no storage for the approval).
 */
function proposeRepair({ agent, state, step, report }) {
  if (!report || report.status !== 'error' || !isTransientStepReport(report)) return null;
  const storage = agent.storage;
  if (!storage || typeof storage.saveToolApproval !== 'function') return null;
  const runId = runIdOf(state);
  if (!runId) return null;
  const stepId = baseStepId(step);
  const budgets = state.repairBudgets && typeof state.repairBudgets === 'object' ? state.repairBudgets : {};
  const journal = journalOf(agent);
  const failed = lastTerminalEvent(journal, runId, step.id, state.workspaceId);
  const errorCode = report.result && report.result.error && typeof report.result.error.code === 'string' ? report.result.error.code : null;
  const planned = createRepairPolicy().planRepair({
    failure: { kind: FAILURE_KINDS.TRANSIENT, stepId, attemptId: failed ? failed.attemptId : null, fingerprint: errorCode },
    budget: budgets[stepId],
  });
  if (!planned.ok) return null;
  const plan = planned.plan;
  const repairStepId = `${stepId}~repair${plan.budgetAfter.attemptsUsed}`;
  const repairAttemptId = `${runId}:step:${repairStepId}:attempt:1`;
  const approval = storage.saveToolApproval({
    tool: REPAIR_TOOL,
    input: `${state.goal} :: repair ${stepId}`,
    approvalKey: `${REPAIR_TOOL}:${runId}:${repairStepId}`,
    status: 'pending',
    policy: { action: 'review', reason: 'repair_requires_fresh_approval' },
    context: {
      workspaceId: state.workspaceId,
      goal: state.goal,
      args: { goal: state.goal, workspaceId: state.workspaceId, checkpointId: state.checkpointId, resumeToken: state.checkpointId },
      repair: { runId, stepId, repairStepId, priorAttemptId: plan.priorAttemptId, planId: plan.attemptId, fingerprint: plan.fingerprint, backoffMs: plan.backoffMs, budgetAfter: plan.budgetAfter },
    },
  });
  if (!approval || !approval.id) return null;
  const proposed = {
    runId,
    eventId: `${runId}:step:${repairStepId}:repair_proposed`,
    type: EVENT_TYPES.REPAIR_PROPOSED,
    workspaceId: state.workspaceId || 'default',
    attemptId: repairAttemptId,
    invocationId: `${runId}:step:${repairStepId}`,
    ...(failed ? { causedByEventId: failed.eventId } : {}),
    payload: { stepId, repairStepId, priorAttemptId: plan.priorAttemptId, approvalId: approval.id, fingerprint: plan.fingerprint, backoffMs: plan.backoffMs, budgetAfter: plan.budgetAfter },
  };
  // The E1 rule, checked where the event is made: a new attempt, and no
  // approval carried over from the failed one.
  if (!checkRepair(proposed, { priorAttemptId: plan.priorAttemptId }).ok) return null;
  appendSafely(journal, proposed);
  state.repairBudgets = { ...budgets, [stepId]: plan.budgetAfter };
  state.pendingRepair = { stepId, repairStepId, approvalId: approval.id, proposedEventId: proposed.eventId, attemptId: repairAttemptId };
  const { attempt: _attempt, ...original } = step;
  return { ...original, id: repairStepId, rationale: `Repair of ${stepId} after a transient failure (${errorCode || 'error'}).` };
}

function storedApproval(storage, approvalId, workspaceId) {
  if (!storage || typeof storage.getToolApprovalById !== 'function') return null;
  try {
    return storage.getToolApprovalById(approvalId, workspaceId);
  } catch (_) {
    return null;
  }
}

function approvalContext(row) {
  if (!row) return {};
  if (row.context && typeof row.context === 'object') return row.context;
  try {
    return JSON.parse(row.context_json || '{}');
  } catch (_) {
    return {};
  }
}

/**
 * On resume: decide what the pending repair may do. Returns
 * `{ action: 'run' | 'wait' | 'drop' }`. Only the stored approval for exactly
 * this repair, approved or being executed, lets it run.
 */
function resolvePendingRepair({ agent, state, queued, opts = {} }) {
  const pending = state.pendingRepair;
  if (!pending) return { action: 'none' };
  const row = storedApproval(agent.storage, pending.approvalId, state.workspaceId || 'default');
  const context = approvalContext(row);
  const matches = row && row.tool === REPAIR_TOOL && context.repair && context.repair.repairStepId === pending.repairStepId;
  if (matches && row.status === 'rejected') {
    const at = queued.findIndex((step) => step.id === pending.repairStepId);
    if (at >= 0) queued.splice(at, 1);
    // Without its repair the failure stands: the failed attempt goes back
    // among the run's steps so the run ends the way it would have.
    const failedAttempts = Array.isArray(state.failedAttempts) ? state.failedAttempts : [];
    const failed = [...failedAttempts].reverse().find((report) => baseStepId(report) === pending.stepId);
    if (failed) state.steps = [...(state.steps || []), failed];
    delete state.pendingRepair;
    return { action: 'drop' };
  }
  const named = opts.repairApprovalId === pending.approvalId;
  if (matches && named && EXECUTABLE_STATUSES.includes(row.status)) {
    state.activeRepair = pending;
    delete state.pendingRepair;
    return { action: 'run' };
  }
  return { action: 'wait' };
}

/** After a step ran: if it was the approved repair, record that it ran. */
function recordRepairExecuted({ agent, state, report }) {
  const active = state.activeRepair;
  if (!active || !report || report.id !== active.repairStepId) return null;
  delete state.activeRepair;
  const runId = runIdOf(state);
  if (!runId) return null;
  return appendSafely(journalOf(agent), {
    runId,
    eventId: `${runId}:step:${active.repairStepId}:repair_executed`,
    type: EVENT_TYPES.REPAIR_EXECUTED,
    workspaceId: state.workspaceId || 'default',
    attemptId: active.attemptId,
    invocationId: `${runId}:step:${active.repairStepId}`,
    causedByEventId: active.proposedEventId,
    approvalId: active.approvalId,
    executionStatus: report.status === 'done' ? EXECUTION_STATUSES.COMPLETED : EXECUTION_STATUSES.FAILED,
    payload: { stepId: active.stepId, repairStepId: active.repairStepId, status: report.status },
  });
}

module.exports = Object.freeze({
  proposeRepair,
  resolvePendingRepair,
  recordRepairExecuted,
  REPAIR_TOOL,
  REPAIR_PAUSE,
});
