'use strict';

/**
 * #3151: the bounded repair loop in a real AgentV3 run. A transient failure
 * that exhausted its in-run retries is proposed for repair, waits for a fresh
 * approval, and runs automatically once that approval is given.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KernelV2 = require('../kernel.v2');
const HuqanStorage = require('../storage');
const { createAgent } = require('../agentRuntime');
const { createMcpApprovalDecisionHandler } = require('../lib/mcp-approval-decision-handler');
const { REPAIR_TOOL, REPAIR_PAUSE } = require('../lib/experience/run-repair');

const GOAL = 'answer one question';
const WS = 'ws-repair';
const TIMEOUT = Object.freeze({ ok: false, type: 'ask', data: null, evidence: [], error: { code: 'ETIMEDOUT', message: 'network timeout' } });
const ANSWER = Object.freeze({ ok: true, type: 'ask', data: { summary: 'answered' }, evidence: [] });

const decide = createMcpApprovalDecisionHandler({
  failApprovalDecision: (code, message, meta = {}) => ({ ok: false, type: 'approval', data: null, evidence: [], error: { code, message }, meta }),
});

function setup(t, answers) {
  try { require('better-sqlite3'); } catch (_) { t.skip('better-sqlite3 unavailable'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-repair-'));
  const storage = new HuqanStorage({ dbPath: path.join(dir, 'repair.db') });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph-memory.json') });
  const calls = [];
  kernel.ask = (input) => {
    const answer = answers[Math.min(calls.length, answers.length - 1)];
    calls.push(input);
    return answer;
  };
  const makeAgent = (store = storage) => {
    const agent = createAgent({ kernel, storage: store, maxSteps: 1, timeBudgetMs: 5000, dreamExperimentLoop: false });
    agent.baseAgent.plan = (goal) => ({ ok: true, type: 'plan', data: { goal, objective: 'answer', selectedTools: ['ask'], steps: [{ id: 's1', action: 'ask', tool: 'ask', input: 'q1' }], maxSteps: 1 } });
    return agent;
  };
  const runtime = { approvalStore: storage, createRepairAgent: (_kernel, store) => makeAgent(store) };
  return { storage, kernel, calls, makeAgent, runtime, journal: () => kernel.experienceJournal };
}

function repairApproval(storage) {
  return storage.listPendingToolApprovals(20, WS).find((row) => row.tool === REPAIR_TOOL) || null;
}

function eventsOf(env, runId) {
  return env.journal().read(runId, { workspaceId: WS });
}

test('a transient failure that exhausted its retries is proposed for repair and pauses the run', (t) => {
  const env = setup(t, [TIMEOUT]);
  if (!env) return;
  const result = env.makeAgent().run(GOAL, { workspaceId: WS });
  assert.equal(env.calls.length, 3, 'the in-run retry ran first (1 + 2 retries)');
  assert.equal(result.data.status, 'paused');
  assert.equal(result.data.pauseReason, REPAIR_PAUSE);
  assert.deepEqual(result.data.queuedSteps.map((step) => step.id), ['s1~repair1']);
  assert.equal(result.data.failedAttempts.length, 1);
  assert.deepEqual(result.data.repairBudgets.s1, { attemptsUsed: 1, maxAttempts: 3 });

  const approval = repairApproval(env.storage);
  assert.ok(approval, 'a pending repair approval exists');
  assert.equal(approval.status, 'pending');

  const events = eventsOf(env, result.data.observabilityRunId);
  const proposed = events.find((e) => e.type === 'repair_proposed');
  assert.ok(proposed, events.map((e) => e.type).join(','));
  const failed = events.find((e) => e.eventId === proposed.causedByEventId);
  assert.ok(failed, 'the proposal is caused by the failed attempt');
  assert.equal(failed.invocationId, `${result.data.observabilityRunId}:step:s1`);
  assert.notEqual(proposed.attemptId, failed.attemptId, 'a repair is a new attempt');
  assert.equal(proposed.payload.approvalId, approval.id);
  assert.equal(proposed.approvalId, undefined, 'no approval is carried over');
});

test('without its approval the repair never runs, even if an approval id is named', (t) => {
  const env = setup(t, [TIMEOUT]);
  if (!env) return;
  env.makeAgent().run(GOAL, { workspaceId: WS });
  const approval = repairApproval(env.storage);
  const waiting = env.makeAgent().run(GOAL, { workspaceId: WS });
  assert.equal(waiting.data.pauseReason, REPAIR_PAUSE);
  // Naming the pending approval proves nothing while it is still pending.
  const forged = env.makeAgent().run(GOAL, { workspaceId: WS, repairApprovalId: approval.id });
  assert.equal(forged.data.pauseReason, REPAIR_PAUSE);
  assert.equal(env.calls.length, 3, 'the repair step did not run');
});

test('approving the repair runs it automatically and records it (SQLite)', async (t) => {
  const env = setup(t, [TIMEOUT, TIMEOUT, TIMEOUT, ANSWER]);
  if (!env) return;
  const paused = env.makeAgent().run(GOAL, { workspaceId: WS });
  const runId = paused.data.observabilityRunId;
  const approval = repairApproval(env.storage);

  const decision = await decide(env.kernel, { approvalId: approval.id, decision: 'approved', workspaceId: WS }, env.runtime);
  assert.equal(decision.ok, true, JSON.stringify(decision.error));
  assert.equal(decision.data.executed, true);
  assert.equal(decision.data.receipt.tool, REPAIR_TOOL);
  const resumed = decision.data.result;
  assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
  assert.equal(resumed.data.status, 'completed');
  assert.equal(resumed.data.observabilityRunId, runId, 'the approved repair resumed the same run');
  assert.deepEqual(resumed.data.steps.map((step) => [step.id, step.status]), [['s1~repair1', 'done']]);
  assert.equal(env.calls.length, 4, 'the repair ran once, with no further human step');
  assert.equal(env.storage.getToolApprovalById(approval.id, WS).status, 'approved');

  const events = eventsOf(env, runId);
  const proposed = events.find((e) => e.type === 'repair_proposed');
  const executed = events.find((e) => e.type === 'repair_executed');
  assert.ok(executed, events.map((e) => e.type).join(','));
  assert.equal(executed.causedByEventId, proposed.eventId);
  assert.equal(executed.approvalId, approval.id);
  assert.equal(executed.attemptId, proposed.attemptId);
  assert.equal(executed.executionStatus, 'completed');
  assert.ok(events.some((e) => e.type === 'execution_finished' && e.attemptId === executed.attemptId), 'the repair step ran under the repair attempt');
});

test('a rejected repair is dropped and the run ends with the failure it had', async (t) => {
  const env = setup(t, [TIMEOUT]);
  if (!env) return;
  env.makeAgent().run(GOAL, { workspaceId: WS });
  const approval = repairApproval(env.storage);
  const decision = await decide(env.kernel, { approvalId: approval.id, decision: 'rejected', workspaceId: WS }, env.runtime);
  assert.equal(decision.ok, true);
  const after = env.makeAgent().run(GOAL, { workspaceId: WS });
  assert.equal(after.ok, false);
  assert.equal(after.data.status, 'blocked');
  assert.deepEqual(after.data.steps.map((step) => [step.id, step.status]), [['s1', 'error']]);
  assert.equal(env.calls.length, 3, 'a rejected repair never runs');
  assert.ok(!eventsOf(env, after.data.observabilityRunId).some((e) => e.type === 'repair_executed'));
});

test('a permanent failure is not repaired', (t) => {
  const env = setup(t, [{ ok: false, type: 'ask', data: null, evidence: [], error: { code: 'BAD_INPUT', message: 'the question is malformed' } }]);
  if (!env) return;
  const result = env.makeAgent().run(GOAL, { workspaceId: WS });
  assert.equal(result.data.status, 'blocked');
  assert.equal(env.calls.length, 1, 'not retryable, so not retried either');
  assert.equal(repairApproval(env.storage), null);
  assert.ok(!eventsOf(env, result.data.observabilityRunId).some((e) => e.type === 'repair_proposed'));
});

test('a repair that fails again is recorded and re-proposed within its budget', async (t) => {
  const env = setup(t, [TIMEOUT]);
  if (!env) return;
  const paused = env.makeAgent().run(GOAL, { workspaceId: WS });
  const runId = paused.data.observabilityRunId;
  let approval = repairApproval(env.storage);
  const first = await decide(env.kernel, { approvalId: approval.id, decision: 'approved', workspaceId: WS }, env.runtime);
  const again = first.data.result;
  assert.equal(again.data.pauseReason, REPAIR_PAUSE);
  assert.deepEqual(again.data.queuedSteps.map((step) => step.id), ['s1~repair2']);
  assert.deepEqual(again.data.repairBudgets.s1, { attemptsUsed: 2, maxAttempts: 3 });
  const executed = eventsOf(env, runId).filter((e) => e.type === 'repair_executed');
  assert.deepEqual(executed.map((e) => e.executionStatus), ['failed']);

  approval = repairApproval(env.storage);
  const second = await decide(env.kernel, { approvalId: approval.id, decision: 'approved', workspaceId: WS }, env.runtime);
  const third = second.data.result;
  assert.deepEqual(third.data.repairBudgets.s1, { attemptsUsed: 3, maxAttempts: 3 });
  approval = repairApproval(env.storage);
  const last = (await decide(env.kernel, { approvalId: approval.id, decision: 'approved', workspaceId: WS }, env.runtime)).data.result;
  // The budget is spent: no fourth proposal, and the run ends with the failure.
  assert.equal(last.data.status, 'blocked');
  assert.equal(repairApproval(env.storage), null);
  assert.equal(eventsOf(env, runId).filter((e) => e.type === 'repair_proposed').length, 3);
});
