'use strict';

// #3474 I6: the local recurrent model. Determinism, the candidate-only boundary
// and the closed-form readout are the load-bearing behaviors.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalNeuralModel } = require('../lib/cognitive-model-local-ssm');
const { validateProposal, MODEL_AUTHORITY } = require('../lib/cognitive-model-port');
const { label } = require('../lib/cognitive-lab-neural-world');
const { DESIGN, generateDataset } = require('../lib/cognitive-lab-neural-design');

function sequence(n) { return Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 1 : 0)); }

test('the same seed reproduces the same frozen weights and the same answer', () => {
  const first = createLocalNeuralModel({ seed: 3474, reservoir: 8 });
  const second = createLocalNeuralModel({ seed: 3474, reservoir: 8 });
  assert.deepEqual(first.describe().weightsDigest, second.describe().weightsDigest);
  const training = [{ sequence: sequence(8), label: 1 }, { sequence: Array(8).fill(0), label: -1 }];
  first.train(training);
  second.train(training);
  const input = sequence(8);
  assert.equal(first.predict(input).answer.score, second.predict(input).answer.score);
  assert.equal(first.predict(input).answer.label, second.predict(input).answer.label);
});

test('a different seed produces a different model', () => {
  const a = createLocalNeuralModel({ seed: 3474, reservoir: 8 }).describe();
  const b = createLocalNeuralModel({ seed: 1, reservoir: 8 }).describe();
  assert.notEqual(a.weightsDigest, b.weightsDigest);
});

test('predict returns a CANDIDATE_ONLY proposal and never a verdict', () => {
  const model = createLocalNeuralModel({ reservoir: 8 });
  model.train([{ sequence: sequence(8), label: 1 }, { sequence: Array(8).fill(0), label: -1 }]);
  const proposal = model.predict(sequence(8));
  assert.equal(validateProposal(proposal).status, 'VALID');
  assert.equal(proposal.authority, MODEL_AUTHORITY);
  assert.equal(proposal.canonical, false);
  assert.equal(proposal.locality, 'LOCAL');
  assert.ok(Object.isFrozen(proposal));
  assert.equal(proposal.budget.modelCalls, 0);
  assert.equal(proposal.budget.tokens, 0);
});

test('predict before training fails closed instead of returning a guess', () => {
  const model = createLocalNeuralModel({ reservoir: 8 });
  assert.equal(model.trained, false);
  assert.throws(() => model.predict(sequence(8)), /not trained/);
});

test('malformed inputs and budgets are refused', () => {
  assert.throws(() => createLocalNeuralModel({ reservoir: 0 }), /reservoir/);
  assert.throws(() => createLocalNeuralModel({ reservoir: 4096 }), /reservoir/);
  assert.throws(() => createLocalNeuralModel({ ridge: -1 }), /ridge/);
  const model = createLocalNeuralModel({ reservoir: 8 });
  assert.throws(() => model.train([]), /training samples/);
  assert.throws(() => model.train([{ sequence: [1, 0], label: 1 }]), /steps/);
  assert.throws(() => model.train([{ sequence: Array(8).fill(0), label: NaN }]), /label/);
  model.train([{ sequence: Array(8).fill(1), label: 1 }]);
  assert.throws(() => model.predict([1, 0, 1]), /steps/);
  assert.throws(() => model.predict(Array(8).fill('x')), /finite number or boolean/);
});

test('a trained model separates a bounded accumulation task above chance', () => {
  const model = createLocalNeuralModel({ seed: DESIGN.model.seed, reservoir: DESIGN.model.reservoir, ridge: DESIGN.model.ridge, steps: DESIGN.model.steps });
  const data = generateDataset();
  model.train(data.train.map((item) => ({ sequence: item.sequence, label: label(item.sequence) === 1 ? 1 : -1 })));
  const holdout = data.splits[0].cases;
  const correct = holdout.filter((item) => {
    const predicted = model.predict(item.sequence).answer.label === 'positive' ? 1 : 0;
    return predicted === label(item.sequence);
  }).length;
  assert.ok(correct / holdout.length > 0.75, `expected better than chance, got ${correct / holdout.length}`);
});
