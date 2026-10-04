'use strict';

/**
 * I1 Cognitive Scheduler — real caller wiring and B6 equal-budget ablation
 * (#3311, program #3306).
 *
 * Two layers are pinned here and they are deliberately separate:
 *
 * 1. **Wiring.** With `opts.cognitiveScheduler` the AgentV3 run reorders its
 *    plan's eligible steps through the scheduler; without it the run keeps its
 *    exact FIFO order. This is a production entry → real function → observed
 *    effect test, not a library import.
 * 2. **B6 harness.** A scheduler order is compared against a FIFO baseline on
 *    the same candidate set and the same budget. The comparison reports
 *    `solvedTaskDelta` / `costDelta` and a *locked* meaningful effect. It
 *    reports `NOT_MEASURED` unless a caller supplies a real held-out outcome:
 *    the synthetic fixture here is a wiring check, never a production gain
 *    claim (see program #3306 "gain ≠ wiring").
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');
const { scheduleCandidates } = require('../lib/cognitive-scheduler');
const { scheduleQueuedSteps } = require('../lib/agent-step-progression');

const BYPASS = Kernel.createAdmissionBypassOpts('i1-b6');

function freshAgent(dir, options = {}) {
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(dir, 'memory.json'),
  });
  kernel.learn('kedi hayvandir', BYPASS);
  return new AgentV3({
    kernel,
    dbPath: path.join(dir, 'memory.db'),
    maxSteps: 4,
    maxIterations: 4,
    timeBudgetMs: 5000,
    dreamExperimentLoop: false,
    ...options,
  });
}

/**
 * The default storage opens its own SQLite handle at dir/memory.db. Close it
 * before removing the temp directory: Windows refuses to delete a file whose
 * handle is still open (EPERM), and a best-effort rm keeps the failure from
 * masking the assertion that already ran.
 */
function releaseAgentStorage(agent, dir) {
  try { agent.storage.close(); } catch (_) { /* closing is best effort */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* removing is best effort */ }
}

test('an opt-in scheduler reorders plan steps before the loop drains them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i1-sched-on-'));
  const agent = freshAgent(dir);
  try {
    const plan = agent.plan('dream kedi hayvandir mi?');
    assert.deepEqual(plan.data.steps.map((step) => step.action), ['ask', 'verify', 'dream']);

    const run = agent.run('dream kedi hayvandir mi?', {
      resume: false,
      maxIterations: 1,
      timeBudgetMs: 5000,
      cognitiveScheduler: { maxRiskTier: 'low', budget: 100 },
    });
    assert.equal(run.ok, true);
    // The goal names "dream", so relevance lifts the dream step ahead of ask.
    assert.equal(run.data.steps[0].action, 'dream');
  } finally {
    releaseAgentStorage(agent, dir);
  }
});

test('without the option the run keeps its FIFO order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i1-sched-off-'));
  const agent = freshAgent(dir);
  try {
    const run = agent.run('dream kedi hayvandir mi?', { resume: false, maxIterations: 1, timeBudgetMs: 5000 });
    assert.equal(run.ok, true);
    assert.equal(run.data.steps[0].action, 'ask');
  } finally {
    releaseAgentStorage(agent, dir);
  }
});

test('scheduleQueuedSteps applies only a total order and never drops work on a partial one', () => {
  const queued = [
    { id: 'ask-1', action: 'ask', tool: 'ask' },
    { id: 'verify-2', action: 'verify', tool: 'verify' },
    { id: 'dream-3', action: 'dream', tool: 'dream' },
  ];
  const opts = { cognitiveScheduler: { maxRiskTier: 'low', budget: 1 } };

  const result = scheduleQueuedSteps({ state: {}, queued, opts, goal: 'dream kedi' });

  assert.equal(result.applied, false);
  assert.equal(result.deferred.length, 2);
  assert.ok(result.deferred.includes('ask-1') || result.deferred.includes('dream-3'));
  // A budget that can afford only one step must not shrink the durable queue.
  assert.deepEqual(queued.map((step) => step.id), ['ask-1', 'verify-2', 'dream-3']);
});

test('a cognitive scheduler whose budget selects nothing leaves the run byte-for-byte on FIFO', () => {
  const goal = 'dream kedi hayvandir mi?';
  const fifoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i1-sched-fifo-'));
  const fifoAgent = freshAgent(fifoDir);
  const zeroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i1-sched-zero-'));
  const zeroAgent = freshAgent(zeroDir);
  try {
    const fifo = fifoAgent.run(goal, { resume: false, maxIterations: 4, timeBudgetMs: 5000 });
    const zero = zeroAgent.run(goal, {
      resume: false,
      maxIterations: 4,
      timeBudgetMs: 5000,
      cognitiveScheduler: { maxRiskTier: 'low', budget: 0 },
    });
    assert.equal(fifo.ok, true);
    assert.equal(zero.ok, true);
    // Zero selected in a schedulable queue is a no-op, not a discarded plan:
    // the run executes the same steps in the same order as the un-scheduled one.
    assert.deepEqual(zero.data.steps.map((step) => step.action), fifo.data.steps.map((step) => step.action));
  } finally {
    releaseAgentStorage(fifoAgent, fifoDir);
    releaseAgentStorage(zeroAgent, zeroDir);
  }
});

function solveCount(order, outcomes, budget) {
  let spent = 0;
  let solved = 0;
  for (const key of order) {
    const row = outcomes[key];
    if (!row) continue;
    if (spent + row.cost > budget) break;
    spent += row.cost;
    if (row.solved) solved += 1;
  }
  return { solved, spent };
}

function b6Ablation({ candidates, outcomes, budget }, contract) {
  if (!contract || !Number.isFinite(contract.meaningfulEffect)) {
    return { gain: 'NOT_MEASURED', reason: 'meaningful effect must be locked before scoring' };
  }
  const baselineOrder = candidates.map((candidate) => candidate.key);
  const scheduledOrder = scheduleCandidates({ candidates, budget }).order;
  const baseline = solveCount(baselineOrder, outcomes, budget);
  const scheduled = solveCount(scheduledOrder, outcomes, budget);
  const solvedTaskDelta = scheduled.solved - baseline.solved;
  const costDelta = scheduled.spent - baseline.spent;
  const meetsEffect = solvedTaskDelta >= contract.meaningfulEffect && costDelta <= 0;
  return {
    baseline,
    scheduled,
    scheduledOrder,
    solvedTaskDelta,
    costDelta,
    gain: meetsEffect ? 'MEASURED' : 'NO_GAIN',
  };
}

test('B6 equal-budget ablation: the scheduler beats FIFO on the locked fixture', () => {
  const candidates = [
    { key: 'x:low-1', family: 'x', urgency: 0, cost: 1 },
    { key: 'x:low-2', family: 'x', urgency: 0, cost: 1 },
    { key: 'x:high-1', family: 'x', urgency: 1, cost: 1 },
    { key: 'x:high-2', family: 'x', urgency: 1, cost: 1 },
  ];
  const outcomes = {
    'x:low-1': { solved: false, cost: 1 },
    'x:low-2': { solved: false, cost: 1 },
    'x:high-1': { solved: true, cost: 1 },
    'x:high-2': { solved: true, cost: 1 },
  };
  // Same candidates, same budget of 2: FIFO spends it on the two low-value
  // steps, the scheduler on the two high-value ones. Equal spend, more solved.
  const result = b6Ablation({ candidates, outcomes, budget: 2 }, { meaningfulEffect: 1 });
  assert.equal(result.baseline.spent, result.scheduled.spent, 'both arms must spend the same budget');
  assert.ok(result.scheduled.solved > result.baseline.solved, 'scheduler must solve more within the same budget');
  assert.equal(result.costDelta, 0);
  assert.equal(result.gain, 'MEASURED');
});

test('B6 ablation stays NOT_MEASURED without a locked meaningful effect', () => {
  const result = b6Ablation({ candidates: [{ key: 'a:1', family: 'a' }], outcomes: { 'a:1': { solved: true, cost: 1 } }, budget: 1 }, null);
  assert.equal(result.gain, 'NOT_MEASURED');
});

test('a priority mutation that drops the risk ceiling is caught by the ablation', () => {
  const candidates = [
    { key: 'safe:1', family: 'safe', urgency: 0, riskTier: 'low', cost: 1 },
    { key: 'risky:1', family: 'risky', urgency: 1, riskTier: 'high', cost: 1 },
  ];
  const correct = scheduleCandidates({ candidates }, { maxRiskTier: 'medium' });
  assert.deepEqual(correct.order, ['safe:1']);
  // A mutation that relaxes the ceiling would let the riskier candidate in;
  // the gate the caller relies on is the ceiling, so the mutant is observable.
  const mutated = scheduleCandidates({ candidates }, { maxRiskTier: 'high' });
  assert.deepEqual(mutated.order, ['risky:1', 'safe:1']);
});

test('#3447: the wired scheduler keeps the plan order on a learn goal (the solution step runs first)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i1-learn-'));
  const agent = freshAgent(dir);
  try {
    const plan = agent.plan('öğren yeni kural');
    assert.equal(plan.data.objective, 'learn');
    assert.deepEqual(plan.data.steps.map((step) => step.id), ['ingest', 'confirm']);

    const run = agent.run('öğren yeni kural', {
      resume: false,
      maxSteps: 2,
      maxIterations: 2,
      timeBudgetMs: 5000,
      cognitiveScheduler: { maxRiskTier: 'low', budget: 100 },
    });
    assert.equal(run.ok, true);
    // The learn objective's relied-on step must lead; before #3447 the key
    // tie-break put `confirm` first and pushed the solution step out of budget.
    assert.equal(run.data.steps[0].id, 'ingest');
  } finally {
    releaseAgentStorage(agent, dir);
  }
});

test('#3447: the wired scheduler promotes the verify step on a plan goal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i1-plan-'));
  const agent = freshAgent(dir);
  try {
    const run = agent.run('plan görev adım', {
      resume: false,
      maxSteps: 2,
      maxIterations: 2,
      timeBudgetMs: 5000,
      cognitiveScheduler: { maxRiskTier: 'low', budget: 100 },
    });
    assert.equal(run.ok, true);
    assert.equal(run.data.steps[0].action, 'verify');
  } finally {
    releaseAgentStorage(agent, dir);
  }
});
