'use strict';

/**
 * Experience Core E3 — the runtime seam adapter (#2378).
 *
 * The one place a live agent run writes an Experience event. Both agent
 * runtimes share `Agent._emit` as their lifecycle hub, so the call site here
 * decides *that* a lifecycle event happened and `lib/experience/` decides what
 * it means. No domain logic lives here.
 *
 * Recorded today: `beforeAgentRun` opens the Experience, `afterAgentRun`
 * closes it, and each step contributes what the shared emit vocabulary can
 * state without inventing a decision.
 *
 * The step pair is the part that is unambiguous. `beforeTask` fires *before*
 * the action firewall and the tool policy decide, so it is an
 * `action_proposed` and never an `execution_started` -- claiming execution
 * started for a step the firewall then refuses would be the exact
 * unmeasured-effect-is-not-no-effect error the epic is about. `afterTask`
 * carries the step's terminal report, so it closes the step with
 * `execution_finished` when the step actually ran (`done`, `error`) and with
 * `failure` when it did not (`blocked`), or when it ran and failed.
 *
 * Deliberately still unwired, and why:
 *
 * - `execution_started` has no honest emit point. The only seam between the
 *   policy/firewall gate and the tool call is inside `executeAgentStep`, and
 *   reaching it needs a new plugin event name -- a public contract change
 *   (`plugin-boundary-contract.test.js` pins the 18-name vocabulary), not a
 *   projection.
 * - `policy_decided` needs the tool policy and the action firewall unified
 *   into one decision surface; they are two gates today.
 * - `verification`, `repair_*`, `memory_update` are the verifier, repair-loop
 *   and memory deliveries from the epic, not runtime seams.
 *
 * A journal is optional. A run with no journal configured is not an error --
 * it is the pre-wiring state every existing caller is in -- so this never
 * throws into the run loop.
 */

const { EVENT_TYPES, EXECUTION_STATUSES } = require('./contract');

const MAX_FAILURE_MESSAGE_CHARS = 200;
const MAX_SUMMARY_CHARS = 200;

/** Bound a free-text field so one long value cannot breach the per-event byte
 * ceiling (`#2375`). Returns undefined for a non-string so the payload keeps
 * its shape rather than gaining a null. */
function boundedText(value, limit) {
  if (typeof value !== 'string') return undefined;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** The Experience identity for a live run. Stamped once so the close event
 * reuses the same runId the open event wrote. */
function runIdOf(state) {
  if (!state || typeof state !== 'object') return null;
  for (const field of ['runId', 'observabilityRunId']) {
    if (typeof state[field] === 'string' && state[field]) return state[field];
  }
  return null;
}

function workspaceIdOf(state) {
  return state && typeof state.workspaceId === 'string' && state.workspaceId
    ? state.workspaceId
    : 'default';
}

/**
 * The step events carry `{ step, state, opts }` rather than the run state, so
 * the identity lives one level down. The step key is what distinguishes the
 * two shapes -- the run state has no `step` field -- and reading it that way
 * keeps the call sites in `agent.js` unchanged.
 */
function stateOf(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.step && data.state && typeof data.state === 'object') return data.state;
  return data;
}

/**
 * The step's stable identity. `invocationId` repeats across retries of the
 * same step (that is what makes them the same invocation); `attemptId` is
 * unique per try and binds to this run, matching the journal's
 * attempt-to-run rule. A step with no id records nothing rather than
 * inventing an identity.
 */
function stepIdentity(runId, step, attemptHint) {
  if (!step || typeof step !== 'object') return null;
  const stepId = typeof step.id === 'string' && step.id ? step.id : null;
  if (!stepId) return null;
  const raw = Number.isInteger(step.attempt) ? step.attempt : attemptHint;
  const attempt = Number.isInteger(raw) && raw > 0 ? raw : 1;
  return {
    stepId,
    attempt,
    invocationId: `${runId}:step:${stepId}`,
    attemptId: `${runId}:step:${stepId}:attempt:${attempt}`,
    proposedEventId: `${runId}:step:${stepId}:${attempt}:proposed`,
    finishedEventId: `${runId}:step:${stepId}:${attempt}:finished`,
    failureEventId: `${runId}:step:${stepId}:${attempt}:failure`,
  };
}

/** The failure detail, bounded so one long error cannot breach the per-event
 * byte ceiling (`#2375`). The code is kept whole; only the message is cut. */
function failurePayloadOf(step) {
  const error = step && step.result && step.result.error ? step.result.error : {};
  const code = typeof error.code === 'string' && error.code ? error.code : null;
  return {
    stepId: step && step.id ? step.id : null,
    tool: step && step.tool ? step.tool : null,
    status: step && step.status ? step.status : null,
    code,
    message: boundedText(error.message, MAX_FAILURE_MESSAGE_CHARS) || '',
  };
}

/** `blocked` means the step never ran, so it is a failure and not an
 * `execution_finished`; `done` and `error` both ran and differ only in the
 * execution status they report. */
function executionStatusOfStep(step) {
  const status = step && step.status;
  if (status === 'done') return EXECUTION_STATUSES.COMPLETED;
  if (status === 'error') return EXECUTION_STATUSES.FAILED;
  return undefined;
}

/** Derived from the run outcome, never inferred from the goal. A run that did
 * not reach a terminal status (paused on a time budget, for example) is left
 * without an executionStatus on purpose: it is not a completed execution. */
function executionStatusOf(status) {
  if (status === 'completed') return EXECUTION_STATUSES.COMPLETED;
  if (status === 'blocked') return EXECUTION_STATUSES.FAILED;
  return undefined;
}

/**
 * Project one lifecycle signal into the journal. Called from `Agent._emit`,
 * which is best-effort for its other consumers (observability, plugins); a
 * journal refusal must not escalate into the run loop, so the result is
 * returned for a caller that wants it but never thrown.
 */
function emitRunLifecycle(event, data, journal) {
  if (!journal || typeof journal.append !== 'function') return null;
  if (!data || typeof data !== 'object') return null;
  const state = stateOf(data);
  const runId = runIdOf(state);
  if (!runId) return null;
  const workspaceId = workspaceIdOf(state);

  if (event === 'beforeAgentRun') {
    // Stamp the identity onto the state so the matching close reuses it even
    // when the caller only ever supplied an observability id.
    if (!state.runId) state.runId = runId;
    return journal.append({
      runId,
      eventId: `${runId}:run_started`,
      type: EVENT_TYPES.RUN_STARTED,
      workspaceId,
      payload: {
        goal: state.goal,
        agentId: state.agentId,
        resumed: state.resumed === true,
      },
    });
  }

  if (event === 'beforeTask') {
    const identity = stepIdentity(runId, data.step);
    if (!identity) return null;
    return journal.append({
      runId,
      eventId: identity.proposedEventId,
      type: EVENT_TYPES.ACTION_PROPOSED,
      workspaceId,
      attemptId: identity.attemptId,
      invocationId: identity.invocationId,
      payload: {
        stepId: identity.stepId,
        action: data.step.action,
        tool: data.step.tool,
        attempt: identity.attempt,
      },
    });
  }

  if (event === 'afterTask') {
    const step = data.step;
    const identity = stepIdentity(runId, step, data.attempt);
    if (!identity) return null;
    const executionStatus = executionStatusOfStep(step);
    if (executionStatus) {
      return journal.append({
        runId,
        eventId: identity.finishedEventId,
        type: EVENT_TYPES.EXECUTION_FINISHED,
        workspaceId,
        attemptId: identity.attemptId,
        invocationId: identity.invocationId,
        // The proposal is what caused this step's terminal event. A refusal
        // is still caused by the proposal it refused.
        causedByEventId: identity.proposedEventId,
        executionStatus,
        payload: {
          stepId: identity.stepId,
          tool: step.tool,
          status: step.status,
          summary: boundedText(step.summary, MAX_SUMMARY_CHARS),
        },
      });
    }
    // A blocked step never ran, so it is a failure, not a finished execution.
    return journal.append({
      runId,
      eventId: identity.failureEventId,
      type: EVENT_TYPES.FAILURE,
      workspaceId,
      attemptId: identity.attemptId,
      invocationId: identity.invocationId,
      causedByEventId: identity.proposedEventId,
      payload: failurePayloadOf(step),
    });
  }

  if (event === 'afterAgentRun') {
    const executionStatus = executionStatusOf(state.status);
    // A run that did not reach a terminal status (paused on a time budget) is
    // left open on purpose: the acceptance contract distinguishes a run that
    // finished from one that merely stopped, and a premature run_closed would
    // make a half-done run look complete after a restart.
    if (!executionStatus) return null;
    return journal.append({
      runId,
      eventId: `${runId}:run_closed`,
      type: EVENT_TYPES.RUN_CLOSED,
      workspaceId,
      executionStatus,
      payload: {
        status: state.status,
        finalAnswer: state.finalAnswer,
        iterationsDelta: Number.isFinite(state.iterationsDelta) ? state.iterationsDelta : 0,
      },
    });
  }

  return null;
}

module.exports = { emitRunLifecycle, runIdOf, stepIdentity, stateOf };
