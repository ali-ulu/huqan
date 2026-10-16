'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { CausalSimulator } = require('../causalSimulator');
const { createExperienceJournal } = require('../lib/experience/journal');
const { CausalRuntime } = require('../lib/causal/causal-runtime');
const { rollout, compare, explainPrediction, MAX_PLAN_STEPS } = require('../lib/causal/symbolic-world-model');
const { ACTIONS, TRAINED, PLANS, GOAL, FRAME, policy, executePlan, recordPair } = require('../lib/cognitive-lab-world-model-world');

const STRATA = [[true, false], [false, false], [true, true], [false, true]];
function pre(energized, jammed, nuisance = 7) { return { door: false, energized, jammed, nuisance }; }
function setup(t, { pairsPerStratum = 3, actions = TRAINED, evaluatePolicy = policy } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-world-model-'));
  const graph = new Graph({ useSQLite: true, memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') });
  t.after(() => { graph.closeSqlite(); fs.rmSync(dir, { recursive: true, force: true }); });
  const journal = createExperienceJournal();
  const runtime = new CausalRuntime({ graph, journal, frameId: FRAME, evaluatePolicy });
  for (const [s, [energized, jammed]] of STRATA.entries()) {
    for (let i = 0; i < pairsPerStratum; i++) {
      for (const proposed of actions) recordPair(journal, runtime, { id: `t-${s}-${i}-${proposed.name}`, preState: pre(energized, jammed, s * 10 + i), action: proposed });
    }
  }
  return { runtime, simulator: new CausalSimulator(graph, { causalRuntime: runtime }) };
}

test('a supported multistep rollout chains learned steps and matches the environment at every step', t => {
  const { simulator } = setup(t);
  const plan = [ACTIONS.energize, ACTIONS.unjam, ACTIONS.unlock];
  const start = pre(false, true, 999);
  const result = simulator.rolloutPlan({ preState: start, plan, desiredState: GOAL });
  assert.equal(result.level, 2);
  assert.equal(result.status, 'PREDICTED');
  assert.equal(result.goalReached, true);
  assert.equal(result.totalCost, 4);
  assert.equal(result.executes, false);
  assert.equal(result.authority, 'PREDICTIVE_MODEL_ONLY');
  assert.deepEqual(result.steps.map(step => step.preStateOrigin), ['observed', 'predicted', 'predicted']);
  assert.deepEqual(result.steps.map(step => step.postState), executePlan(start, plan));
  assert.equal(result.supportFloor, 3);
});

test('an untrained step stops the rollout as UNKNOWN and never yields a final state or a reached goal', t => {
  const { simulator } = setup(t);
  const result = simulator.rolloutPlan({ preState: pre(true, false), plan: [ACTIONS.reset, ACTIONS.unlock], desiredState: GOAL });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.stoppedAt, 0);
  assert.equal(result.unknownAction.name, 'reset');
  assert.equal(result.finalState, null);
  assert.equal(result.goalReached, null);
  assert.equal(result.steps.length, 0);
});

test('a later unsupported step keeps the supported prefix and stops at the gap', t => {
  const { simulator } = setup(t, { actions: [ACTIONS.energize] });
  const result = simulator.rolloutPlan({ preState: pre(false, false), plan: [ACTIONS.energize, ACTIONS.unlock] });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.stoppedAt, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].postState.energized, true);
});

test('policy refusal is checked at every step, including predicted intermediate states', t => {
  const { simulator } = setup(t);
  const refused = simulator.rolloutPlan({ preState: pre(true, false), plan: [ACTIONS.energize, ACTIONS.force] });
  assert.equal(refused.status, 'REJECTED');
  assert.equal(refused.stoppedAt, 1);
  assert.equal(refused.reason, 'unsafe_force');
  const seen = [];
  const throwing = { workspaceId: 'default', frameId: FRAME, forward: () => assert.fail('forward must not run'), evaluatePolicy: () => { throw new Error('down'); } };
  assert.equal(rollout(throwing, { preState: pre(true, false), plan: [ACTIONS.unlock] }).reason, 'policy_unknown_or_unavailable');
  const missing = { workspaceId: 'default', frameId: FRAME, forward: input => { seen.push(input); return { status: 'PREDICTED' }; } };
  assert.equal(rollout(missing, { preState: pre(true, false), plan: [ACTIONS.unlock] }).status, 'REJECTED');
  assert.equal(seen.length, 0);
});

test('compare needs two plans and keeps selected, costlier, unsupported and refused plans visible', t => {
  const { simulator } = setup(t);
  assert.throws(() => simulator.comparePlans({ preState: pre(true, true), desiredState: GOAL, plans: [PLANS[0]] }), /2-16 plans/);
  const result = simulator.comparePlans({ preState: pre(true, true), desiredState: GOAL, plans: PLANS });
  assert.equal(result.status, 'SELECTED');
  assert.deepEqual(result.selected.plan.map(step => step.name), ['unjam', 'unlock']);
  const byDisposition = Object.groupBy(result.alternatives, item => item.disposition);
  assert.deepEqual(byDisposition.policy_rejected.map(item => item.plan[0].name), ['force']);
  assert.deepEqual(byDisposition.unknown.map(item => item.plan[0].name), ['reset']);
  assert.deepEqual(byDisposition.goal_not_reached.map(item => item.plan.map(step => step.name).join('+')), ['unlock', 'energize+unlock']);
  assert.deepEqual(byDisposition.feasible_not_selected.map(item => item.rollout.totalCost), [4, 6]);
  assert.equal(result.alternatives.length, PLANS.length);
});

test('no supported allowed plan reaching the goal is UNKNOWN, not a cheapest guess', t => {
  const { simulator } = setup(t, { actions: [ACTIONS.energize] });
  const result = simulator.comparePlans({ preState: pre(false, true), desiredState: GOAL, plans: [PLANS[1], PLANS[5], PLANS[6]] });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.selected, null);
  assert.ok(result.alternatives.every(item => item.disposition !== 'selected'));
});

test('support withdrawal applies to the next snapshot and turns a supported rollout UNKNOWN', t => {
  const { runtime, simulator } = setup(t);
  const query = { preState: pre(false, false), plan: [ACTIONS.energize, ACTIONS.unlock] };
  const before = simulator.rolloutPlan(query);
  assert.equal(before.status, 'PREDICTED');
  const snapshot = runtime.snapshot();
  runtime.withdrawSupport({ sourceHash: before.steps[1].support[0], reason: 'source retracted' });
  assert.equal(rollout(snapshot, query).status, 'PREDICTED', 'an issued snapshot is a consistent read');
  const after = simulator.rolloutPlan(query);
  assert.equal(after.status, 'UNKNOWN');
  assert.equal(after.stoppedAt, 1);
});

test('rollout budgets bound plan length and learned operations', t => {
  const { simulator } = setup(t);
  assert.throws(() => simulator.rolloutPlan({ preState: pre(true, false), plan: Array(MAX_PLAN_STEPS + 1).fill(ACTIONS.unlock) }), /1-8 actions/);
  assert.throws(() => simulator.rolloutPlan({ preState: pre(true, false), plan: [] }), /1-8 actions/);
  const tight = simulator.rolloutPlan({ preState: pre(false, true), plan: PLANS[3], maxOperations: 1 });
  assert.equal(tight.status, 'UNKNOWN');
  assert.equal(tight.reason, 'rollout_operation_budget_exhausted');
});

test('explainPrediction reports per-step support, predicted origins, the stop and fixed caveats', t => {
  const { simulator } = setup(t);
  const supported = simulator.explainPrediction(simulator.rolloutPlan({ preState: pre(false, false), plan: PLANS[1] }));
  assert.deepEqual(supported.steps.map(step => [step.action, step.preStateOrigin, step.independentSamples, step.supportSources]),
    // energize generalises over the varied jammed dimension; unlock needs both conditions.
    [['energize', 'observed', 6, 12], ['unlock', 'predicted', 3, 6]]);
  assert.equal(supported.stop, null);
  assert.ok(supported.caveats.some(item => /not a calibrated probability/.test(item)));
  const stoppedAtReset = simulator.explainPrediction(simulator.rolloutPlan({ preState: pre(false, false), plan: PLANS[6] }));
  assert.deepEqual([stoppedAtReset.stop.index, stoppedAtReset.stop.status, stoppedAtReset.stop.action.name], [0, 'UNKNOWN', 'reset']);
  assert.throws(() => explainPrediction({ status: 'PREDICTED' }), /level 2/);
});

test('without a learned runtime the simulator keeps Level 0 traversal and reports Level 2 as not configured', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-world-model-l0-'));
  const graph = new Graph({ useSQLite: true, memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') });
  t.after(() => { graph.closeSqlite(); fs.rmSync(dir, { recursive: true, force: true }); });
  const simulator = new CausalSimulator(graph);
  assert.equal(simulator.rolloutPlan({}).reason, 'learned_causal_runtime_not_configured');
  assert.equal(simulator.comparePlans({}).reason, 'learned_causal_runtime_not_configured');
  const levelZero = simulator.simulateChange({ nodeId: 'absent' });
  assert.equal(levelZero.finalState, undefined);
  assert.equal(levelZero.level, undefined);
});

test('compare rejects a malformed world model snapshot and goal', () => {
  assert.throws(() => rollout(null, { preState: pre(true, false), plan: [ACTIONS.unlock] }), /snapshot/);
  const model = { workspaceId: 'default', frameId: FRAME, forward: () => ({ status: 'UNKNOWN', reason: 'x' }), evaluatePolicy: policy };
  assert.throws(() => compare(model, { preState: pre(true, false), plans: PLANS }), /desiredState/);
  assert.throws(() => rollout(model, { preState: pre(true, false), plan: [ACTIONS.unlock], maxOperations: 0 }), /maxOperations/);
});
