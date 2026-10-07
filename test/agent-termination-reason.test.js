'use strict';

// #3494: every agent run carries one typed terminationReason, the step and
// iteration ceilings are told apart, and a run whose existing stall recovery
// (the forced Dream) did not help stops as `stalled` before either ceiling.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AGENT_PAUSE_REASONS,
  AGENT_TERMINATION_REASONS: R,
  terminationReasonFor,
} = require('../lib/agent-exit-reasons');
const { STALLS_BEFORE_DREAM, STALLS_BEFORE_STOP, stalledBeyondRecovery } = require('../lib/agent-step-progression');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');

function freshAgent(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-termination-'));
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'kernel.json') });
  const agent = new AgentV3({ kernel, memoryPath: path.join(dir, 'agent.json') });
  t.after(() => {
    agent.storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return agent;
}

// Every step reports the same summary, so the progress counter only grows.
function stallingRuntime(agent) {
  const real = agent._runtime();
  let n = 0;
  agent._baseRuntime = {
    ...real,
    executeStepWithRetry: (step) => ({
      id: `${step.id}-${n += 1}`, action: step.action, tool: step.tool, input: step.input,
      rationale: step.rationale, status: 'done', summary: 'same', result: { ok: true, type: step.tool, data: { answer: 'same' } },
    }),
    extractAgentSummary: () => ({ text: 'same' }),
    chooseFollowUp: () => ({ id: 'again', action: 'ask', tool: 'ask', input: 'kedi', rationale: 'again' }),
  };
  return agent;
}

const step = (overrides = {}) => ({ tool: 'ask', status: 'done', result: { ok: true }, ...overrides });

test('the termination vocabulary is one frozen set of distinct values', () => {
  const values = Object.values(R);
  assert.ok(Object.isFrozen(R));
  assert.equal(new Set(values).size, values.length);
  for (const required of ['end_of_plan', 'max_iterations', 'budget_blocked', 'emergency_stop', 'stalled']) {
    assert.ok(values.includes(required), required);
  }
  assert.ok(values.filter(value => value.startsWith('blocked_')).length >= 2);
});

test('every exit of the loop maps to its own reason', () => {
  const ceiling = { status: 'paused', pauseReason: AGENT_PAUSE_REASONS.BUDGET_OR_ITERATION_LIMIT };
  const cases = [
    [{ status: 'completed', steps: [step()] }, {}, R.END_OF_PLAN],
    [{ ...ceiling, steps: [step(), step()], iteration: 2 }, { queued: 1, maxSteps: 2, maxIterations: 50 }, R.MAX_STEPS],
    [{ ...ceiling, steps: [step()], iteration: 1 }, { queued: 1, maxSteps: 4, maxIterations: 1 }, R.MAX_ITERATIONS],
    [{ ...ceiling, steps: [step()], iteration: 1 }, { queued: 1, maxSteps: 4, maxIterations: 9 }, R.INCOMPLETE],
    [{ status: 'paused', pauseReason: AGENT_PAUSE_REASONS.TIME_BUDGET_EXCEEDED, steps: [] }, { queued: 2 }, R.TIME_BUDGET],
    [{ status: 'paused', pauseReason: AGENT_PAUSE_REASONS.REPAIR_PENDING_APPROVAL, steps: [] }, { queued: 1 }, R.AWAITING_REPAIR_APPROVAL],
    [{ status: 'paused', pauseReason: AGENT_PAUSE_REASONS.EXPERIENCE_EFFECT_UNCERTAIN, steps: [] }, { queued: 1 }, R.AWAITING_EFFECT_VERDICT],
    [{ status: 'paused', pauseReason: AGENT_PAUSE_REASONS.STALLED, steps: [] }, { queued: 1 }, R.STALLED],
    [{ status: 'blocked', blockedBy: 'dream-experiment-loop', steps: [] }, {}, R.BLOCKED_DREAM_LOOP],
    [{ status: 'blocked', steps: [step({ result: { ok: false, error: { code: 'AGENT_EMERGENCY_STOPPED' } } })] }, {}, R.EMERGENCY_STOP],
    [{ status: 'blocked', steps: [step({ result: { ok: false, error: { code: 'POLICY_BLOCK' } } })] }, {}, R.BLOCKED_STEP],
  ];
  for (const [state, limits, expected] of cases) {
    assert.equal(terminationReasonFor(state, limits), expected, JSON.stringify(state));
  }
});

test('the stop threshold sits after the existing Dream recovery', () => {
  assert.equal(STALLS_BEFORE_STOP, STALLS_BEFORE_DREAM + 2);
  assert.equal(stalledBeyondRecovery({ progress: { stalledCount: STALLS_BEFORE_STOP - 1 } }), false);
  assert.equal(stalledBeyondRecovery({ progress: { stalledCount: STALLS_BEFORE_STOP } }), true);
  assert.equal(stalledBeyondRecovery({}), false);
});

test('a real run reports which ceiling it reached', async (t) => {
  const steps = await freshAgent(t).run('kedi hayvandir mi?', { dreamExperimentLoop: false, maxSteps: 2 });
  assert.equal(steps.data.terminationReason, R.MAX_STEPS);
  assert.equal(steps.meta.terminationReason, R.MAX_STEPS);
  const iterations = await freshAgent(t).run('kedi hayvandir mi?', { dreamExperimentLoop: false, maxIterations: 1 });
  assert.equal(iterations.data.terminationReason, R.MAX_ITERATIONS);
  // The pause reason both used to share is unchanged for existing readers.
  assert.equal(steps.data.pauseReason, iterations.data.pauseReason);
});

test('a stall stops two steps past the Dream recovery point, with its queue kept', async (t) => {
  const agent = stallingRuntime(freshAgent(t));
  const result = await agent.run('kedi hayvandir mi?', { dreamExperimentLoop: false, maxSteps: 12 });
  assert.equal(result.data.status, 'paused');
  assert.equal(result.data.pauseReason, AGENT_PAUSE_REASONS.STALLED);
  assert.equal(result.data.terminationReason, R.STALLED);
  // The recovery was attempted: a Dream ran or is waiting in the queue. Here
  // the plan's own Dream is queued behind the repeating follow-ups, which is
  // why the forced Dream is not added (shouldForceDream) and progress never
  // moves; the stop is what ends that.
  const dreamed = [...result.data.steps, ...result.data.queuedSteps].some(entry => entry.tool === 'dream');
  assert.ok(dreamed, 'a Dream ran or is queued');
  assert.equal(result.data.progress.stalledCount, STALLS_BEFORE_STOP);
  assert.ok(result.data.steps.length < 12, 'stopped before the step ceiling');
  assert.ok(result.data.queuedSteps.length > 0, 'the next step is kept for a resume');
});

test('a resume after a stall is not stopped again by its own history', async (t) => {
  const agent = stallingRuntime(freshAgent(t));
  const first = await agent.run('kedi hayvandir mi?', { dreamExperimentLoop: false, maxSteps: 30 });
  assert.equal(first.data.terminationReason, R.STALLED);
  const resumed = await agent.run('kedi hayvandir mi?', {
    dreamExperimentLoop: false, maxSteps: 30, checkpointId: first.data.checkpointId, resumeToken: first.data.resumeToken,
  });
  const ranThisTime = resumed.data.steps.length - first.data.steps.length;
  assert.ok(ranThisTime >= STALLS_BEFORE_STOP, `resumed run took ${ranThisTime} steps before stopping`);
  assert.equal(resumed.data.terminationReason, R.STALLED);
});

test('a stale pause reason does not survive into the next stop', async (t) => {
  const agent = freshAgent(t);
  const paused = await agent.run('kedi hayvandir mi?', { dreamExperimentLoop: false, timeBudgetMs: 0 });
  assert.equal(paused.data.pauseReason, AGENT_PAUSE_REASONS.TIME_BUDGET_EXCEEDED);
  assert.equal(paused.data.terminationReason, R.TIME_BUDGET);
  const resumed = await agent.run('kedi hayvandir mi?', {
    dreamExperimentLoop: false, maxIterations: 1, checkpointId: paused.data.checkpointId, resumeToken: paused.data.resumeToken,
  });
  assert.equal(resumed.data.terminationReason, R.MAX_ITERATIONS);
  assert.equal(resumed.data.pauseReason, AGENT_PAUSE_REASONS.BUDGET_OR_ITERATION_LIMIT);
});

test('runs that never enter the loop say why', async (t) => {
  const agent = freshAgent(t);
  const badToken = await agent.run('kedi hayvandir mi?', { checkpointId: 'nope', resumeToken: 'nope' });
  assert.equal(badToken.meta.terminationReason, R.INVALID_REQUEST);
  const halfToken = await agent.run('kedi hayvandir mi?', { checkpointId: 'nope' });
  assert.equal(halfToken.meta.terminationReason, R.INVALID_REQUEST);
  const storage = agent._storageFailure('saveCheckpoint', new Error('disk full'));
  assert.equal(storage.meta.terminationReason, R.STORAGE_FAILURE);

  agent._recordBudgetAuditEvent = () => {};
  agent._checkAgentLoopBudget = () => ({ usageKnown: true, decision: 'block', reason: 'window_exhausted', iterationsUsed: 9, maxIterationsPerWindow: 9 });
  assert.equal((await agent.run('kedi hayvandir mi?', { dreamExperimentLoop: false })).meta.terminationReason, R.BUDGET_BLOCKED);
  agent._checkAgentLoopBudget = () => ({ usageKnown: false, detail: 'counter unreadable' });
  assert.equal((await agent.run('kedi hayvandir mi?', { dreamExperimentLoop: false })).meta.terminationReason, R.BUDGET_UNAVAILABLE);
});
