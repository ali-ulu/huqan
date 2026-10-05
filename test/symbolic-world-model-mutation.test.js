'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const engine = require('../lib/causal/symbolic-world-model');
const { ACTIONS, GOAL, FRAME, policy, execute } = require('../lib/cognitive-lab-world-model-world');

const PRE = { door: false, energized: true, jammed: false, nuisance: 1 };
// A model that knows every trained step exactly and nothing about reset.
const MODEL = Object.freeze({ workspaceId: 'default', frameId: FRAME, evaluatePolicy: policy,
  forward: ({ preState, action }) => (action.name === 'reset' || action.name === 'force'
    ? { status: 'UNKNOWN', reason: 'insufficient_controlled_independent_support', postState: null }
    : { status: 'PREDICTED', postState: execute(preState, action), effect: {}, modelId: 'm', conditions: {}, support: ['s'], independentSamples: 3, operations: 1 }) });
function mutant(relative, original, replacement) {
  const file = path.resolve(__dirname, '..', relative);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(original).length - 1, 1, 'mutation must have exactly one target');
  const compiledFile = file.replace(/\.js$/, '.mutant.cjs');
  const compiled = new Module(compiledFile, module);
  compiled.filename = compiledFile;
  compiled.paths = module.paths;
  compiled._compile(source.replace(original, replacement), compiledFile);
  return compiled.exports;
}

test('continuing past an UNKNOWN step breaks the unobserved-outcome-is-never-success assertion', () => {
  const assertion = ({ compare }) => {
    const result = compare(MODEL, { preState: PRE, desiredState: GOAL, plans: [[ACTIONS.reset, ACTIONS.unlock], [ACTIONS.release]] });
    assert.deepEqual(result.selected.plan.map(step => step.name), ['release']);
    assert.equal(result.alternatives[0].disposition, 'unknown');
  };
  assertion(engine);
  const broken = mutant('lib/causal/symbolic-world-model.js',
    "if (prediction.status !== 'PREDICTED') return stopped(", "if (false) return stopped(");
  assert.throws(() => assertion(broken));
});

test('skipping the per-step policy check breaks the unsafe-plan-is-refused assertion', () => {
  const assertion = ({ compare }) => {
    const result = compare(MODEL, { preState: PRE, desiredState: GOAL, plans: [[ACTIONS.force], [ACTIONS.release]] });
    assert.deepEqual(result.selected.plan.map(step => step.name), ['release']);
    assert.equal(result.alternatives[0].disposition, 'policy_rejected');
  };
  assertion(engine);
  const broken = mutant('lib/causal/symbolic-world-model.js',
    'if (refusal) return stopped(', 'if (false) return stopped(');
  assert.throws(() => assertion(broken), { code: 'ERR_ASSERTION' });
});

test('disabling the simulator Level 2 caller breaks the production-facade assertion', () => {
  // The Graph identity check is deliberately retained; call the prototype.
  const { CausalSimulator } = require('../causalSimulator');
  const host = { causalRuntime: { rollout: input => engine.rollout(MODEL, input) } };
  const assertion = Simulator => assert.equal(Simulator.prototype.rolloutPlan.call(host, { preState: PRE, plan: [ACTIONS.unlock], desiredState: GOAL }).goalReached, true);
  assertion(CausalSimulator);
  const { CausalSimulator: Mutant } = mutant('causalSimulator.js',
    'return this.causalRuntime.rollout(input);', "return { level: 2, status: 'UNKNOWN', goalReached: null };");
  assert.throws(() => assertion(Mutant), { code: 'ERR_ASSERTION' });
});
