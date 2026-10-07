'use strict';

// #3494: every agent run carries one typed terminationReason, the step and
// iteration ceilings are told apart, and a run that repeats itself without
// progress stops as `stalled` before it reaches either ceiling.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AGENT_PAUSE_REASONS,
  AGENT_TERMINATION_REASONS: R,
  STALL_WINDOW,
  terminationReasonFor,
  isStalled,
} = require('../lib/agent-exit-reasons');
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

const step = (overrides = {}) => ({ tool: 'ask', input: 'q', status: 'done', summary: 's', result: { ok: true }, ...overrides });

test('the termination vocabulary is one frozen set of distinct values', () => {
  const values = Object.values(R);
  assert.ok(Object.isFrozen(R));
  assert.equal(new Set(values).size, values.length);
  for (const required of ['end_of_plan', 'max_iterations', 'budget_blocked', 'emergency_stop']) {
    assert.ok(values.includes(required), required);
  }
  assert.ok(values.filter(value => value.startsWith('blocked_')).length >= 2);
});

test('every exit of the loop maps to its own reason', () => {
  const cases = [
    [{ status: 'completed', steps: [step()] }, {}, R.END_OF_PLAN],
    [{ status: 'paused', pauseReason: AGENT_PAUSE_REASONS.BUDGET_OR_ITERATION_LIMIT, steps: [step(), step({ input: 'b' })], iteration: 2 },
      { queued: 1, maxSteps: 2, maxIterations: 50 }, R.MAX_STEPS],
    [{ status: 'paused', pauseReason: AGENT_PAUSE_REASONS.BUDGET_OR_ITERATION_LIMIT, steps: [step()], iteration: 1 },
      { queued: 1, maxSteps: 4, maxIterations: 1 }, R.MAX_ITERATIONS],
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

test('a stall is the same tool, input and outcome for the whole window', () => {
  assert.equal(STALL_WINDOW, 3);
  assert.equal(isStalled([step(), step()]), false, 'shorter than the window');
  assert.equal(isStalled([step(), step(), step()]), true);
  assert.equal(isStalled([step({ input: 'other' }), step(), step(), step()]), true, 'only the tail counts');
  assert.equal(isStalled([step(), step({ input: 'q2' }), step()]), false, 'a different input is progress');
  assert.equal(isStalled([step(), step({ summary: 'new' }), step()]), false, 'a different outcome is progress');
  assert.equal(isStalled([step(), step({ tool: 'verify' }), step()]), false);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(isStalled([step({ input: cyclic }), step({ input: cyclic }), step({ input: cyclic })]), true);
  assert.equal(isStalled(null), false);
});

test('a real run reports which ceiling it reached', async (t) => {
  const steps = await freshAgent(t).run('kedi hayvandir mi?', { dreamExperimentLoop: false, maxSteps: 2 });
  assert.equal(steps.data.status, 'paused');
  assert.equal(steps.data.terminationReason, R.MAX_STEPS);
  assert.equal(steps.meta.terminationReason, R.MAX_STEPS);

  const iterations = await freshAgent(t).run('kedi hayvandir mi?', { dreamExperimentLoop: false, maxIterations: 1 });
  assert.equal(iterations.data.terminationReason, R.MAX_ITERATIONS);
  // The pause reason both used to share is unchanged for existing readers.
  assert.equal(steps.data.pauseReason, iterations.data.pauseReason);
});

test('a run that repeats itself stops as stalled before its step ceiling', async (t) => {
  const agent = freshAgent(t);
  const real = agent._runtime();
  const repeated = { id: 'loop', action: 'ask', tool: 'ask', input: 'kedi', rationale: 'again', status: 'done', summary: 'same', result: { ok: true, data: {} } };
  agent._baseRuntime = {
    ...real,
    executeStepWithRetry: () => ({ ...repeated }),
    chooseFollowUp: () => ({ id: 'loop', action: 'ask', tool: 'ask', input: 'kedi', rationale: 'again' }),
  };
  const result = await agent.run('kedi hayvandir mi?', { dreamExperimentLoop: false, maxSteps: 8 });
  assert.equal(result.data.status, 'paused');
  assert.equal(result.data.pauseReason, AGENT_PAUSE_REASONS.STALLED);
  assert.equal(result.data.terminationReason, R.STALLED);
  assert.equal(result.data.steps.length, STALL_WINDOW, 'stopped at the window, not at maxSteps');
});

test('a refused loop budget carries its reason on the failure', async (t) => {
  const agent = freshAgent(t);
  agent._recordBudgetAuditEvent = () => {};
  agent._checkAgentLoopBudget = () => ({ usageKnown: true, decision: 'block', reason: 'window_exhausted', iterationsUsed: 9, maxIterationsPerWindow: 9 });
  const refused = await agent.run('kedi hayvandir mi?', { dreamExperimentLoop: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.meta.terminationReason, R.BUDGET_BLOCKED);
  agent._checkAgentLoopBudget = () => ({ usageKnown: false, detail: 'counter unreadable' });
  const unknown = await agent.run('kedi hayvandir mi?', { dreamExperimentLoop: false });
  assert.equal(unknown.meta.terminationReason, R.BUDGET_UNAVAILABLE);
});
