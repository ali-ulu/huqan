'use strict';

// #3561 I6: the RWKV, Mamba and small-Transformer candidates. The port contract,
// determinism and the candidate-only boundary are the load-bearing behaviors.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalRwkvModel } = require('../lib/cognitive-model-local-rwkv');
const { createLocalMambaModel } = require('../lib/cognitive-model-local-mamba');
const { createLocalTransformerModel } = require('../lib/cognitive-model-local-transformer');
const { validateProposal, MODEL_AUTHORITY, MODEL_KINDS } = require('../lib/cognitive-model-port');
const { label } = require('../lib/cognitive-lab-neural-world');
const { DESIGN, generateDataset } = require('../lib/cognitive-lab-neural-design');

const FAMILIES = Object.freeze({
  RWKV: createLocalRwkvModel,
  MAMBA: createLocalMambaModel,
  TRANSFORMER: createLocalTransformerModel,
});
const OPTS = { seed: 3474, reservoir: 24, ridge: 0.5, steps: DESIGN.model.steps };

function sequence(n) { return Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 1 : 0)); }
function train(model) { return model.train([{ sequence: sequence(8), label: 1 }, { sequence: Array(8).fill(0), label: -1 }]); }

test('every family answers through the port as CANDIDATE_ONLY and declares its kind', () => {
  for (const [kind, create] of Object.entries(FAMILIES)) {
    assert.ok(MODEL_KINDS.includes(kind));
    const model = train(create({ reservoir: 8 }));
    const proposal = model.predict(sequence(8));
    assert.equal(validateProposal(proposal).status, 'VALID');
    assert.equal(proposal.kind, kind);
    assert.equal(proposal.authority, MODEL_AUTHORITY);
    assert.equal(proposal.canonical, false);
    assert.equal(proposal.locality, 'LOCAL');
    assert.ok(Object.isFrozen(proposal));
    assert.equal(proposal.budget.modelCalls, 0);
    assert.equal(proposal.budget.tokens, 0);
    assert.match(proposal.modelId, new RegExp(`^local-${kind.toLowerCase()}-`));
  }
});

test('the same seed reproduces the same frozen weights and the same answer', () => {
  for (const create of Object.values(FAMILIES)) {
    const first = train(create(OPTS));
    const second = train(create(OPTS));
    assert.equal(first.describe().weightsDigest, second.describe().weightsDigest);
    assert.equal(first.predict(sequence(8)).answer.score, second.predict(sequence(8)).answer.score);
  }
});

test('a different seed produces a different model', () => {
  for (const create of Object.values(FAMILIES)) {
    assert.notEqual(create({ seed: 3474, reservoir: 8 }).describe().weightsDigest, create({ seed: 1, reservoir: 8 }).describe().weightsDigest);
  }
});

test('predict before training fails closed and malformed construction is refused', () => {
  for (const create of Object.values(FAMILIES)) {
    assert.throws(() => create({ reservoir: 8 }).predict(sequence(8)), /not trained/);
    assert.throws(() => create({ reservoir: 0 }), /reservoir/);
    assert.throws(() => create({ reservoir: 4096 }), /reservoir/);
    assert.throws(() => create({ ridge: -1 }), /ridge/);
    assert.throws(() => create({ seed: 3474.9 }), /seed must be an integer/);
    const model = create({ reservoir: 8 });
    assert.throws(() => model.train([]), /training samples/);
    assert.throws(() => model.predict([1, 0, 1]), /steps/);
  }
});

test('each family declares parameters and per-prediction cost and separates the task above chance', () => {
  const data = generateDataset();
  for (const create of Object.values(FAMILIES)) {
    const model = create(OPTS);
    const description = model.describe();
    assert.ok(Number.isInteger(description.parameters) && description.parameters > 0);
    assert.ok(Number.isInteger(description.operationsPerPrediction) && description.operationsPerPrediction > 0);
    model.train(data.train.map((item) => ({ sequence: item.sequence, label: label(item.sequence) === 1 ? 1 : -1 })));
    const holdout = data.splits[0].cases;
    const correct = holdout.filter((item) => (model.predict(item.sequence).answer.label === 'positive' ? 1 : 0) === label(item.sequence)).length;
    assert.ok(correct / holdout.length > 0.75, `${model.kind} got ${correct / holdout.length}`);
  }
});
