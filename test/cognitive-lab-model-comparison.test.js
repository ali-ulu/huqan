'use strict';

// #3561 I6: the B7 model-family comparison. The comparison must run every family
// on the same frozen design and inputs, order them deterministically, and never
// carry authority.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalNeuralModel } = require('../lib/cognitive-model-local-ssm');
const { createLocalRwkvModel } = require('../lib/cognitive-model-local-rwkv');
const { createLocalMambaModel } = require('../lib/cognitive-model-local-mamba');
const { createLocalTransformerModel } = require('../lib/cognitive-model-local-transformer');
const { compareModelFamilies, COMPARISON_SCHEMA_VERSION } = require('../lib/cognitive-lab-model-comparison');
const { MODEL_AUTHORITY } = require('../lib/cognitive-model-port');
const { digest } = require('../lib/causal/causal-episode-contract');

const SHA = 'a'.repeat(40);
const MODELS = Object.freeze({
  SSM: createLocalNeuralModel,
  RWKV: createLocalRwkvModel,
  MAMBA: createLocalMambaModel,
  TRANSFORMER: createLocalTransformerModel,
});

test('the comparison runs every family on the same frozen design and inputs', () => {
  const comparison = compareModelFamilies({ models: MODELS, sourceCommit: SHA, sourceDirty: false });
  assert.equal(comparison.schemaVersion, COMPARISON_SCHEMA_VERSION);
  assert.deepEqual(comparison.families.map((family) => family.kind).sort(), ['MAMBA', 'RWKV', 'SSM', 'TRANSFORMER']);
  for (const family of comparison.families) {
    assert.equal(family.status, 'KEEP');
    assert.equal(family.authority, MODEL_AUTHORITY);
    assert.equal(family.canonical, false);
    assert.equal(family.locality.externalCalls, 0);
    assert.equal(family.budget.modelCalls, 0);
    assert.equal(family.budget.tokens, 0);
    assert.ok(family.accuracy > 0.75);
  }
  assert.equal(comparison.authority, MODEL_AUTHORITY);
  assert.equal(comparison.canonical, false);
  assert.equal(comparison.automaticPromotion, false);
  assert.ok(!comparison.notMeasured.includes('RWKV/Mamba/Transformer comparison'));
});

test('the ranking is deterministic and the best family is its head', () => {
  const first = compareModelFamilies({ models: MODELS, sourceCommit: SHA, sourceDirty: false });
  const second = compareModelFamilies({ models: MODELS, sourceCommit: SHA, sourceDirty: false });
  assert.deepEqual(first.ranking, second.ranking);
  assert.equal(first.best, first.ranking[0].kind);
  assert.equal(first.digest, second.digest);
  for (let i = 1; i < first.ranking.length; i++) assert.ok(first.ranking[i - 1].accuracy >= first.ranking[i].accuracy);
});

test('the comparison refuses a missing or single-family registry before measuring', () => {
  assert.throws(() => compareModelFamilies({ sourceCommit: SHA, sourceDirty: false }), /registry/);
  assert.throws(() => compareModelFamilies({ models: { SSM: createLocalNeuralModel }, sourceCommit: SHA, sourceDirty: false }), /at least two/);
  assert.throws(() => compareModelFamilies({ models: { SSM: createLocalNeuralModel, RWKV: 'no' }, sourceCommit: SHA, sourceDirty: false }), /constructor/);
  assert.throws(() => compareModelFamilies({ models: MODELS }), /source commit/);
});

test('the comparison digest is a pure function of the measured family rows', () => {
  const comparison = compareModelFamilies({ models: MODELS, sourceCommit: SHA, sourceDirty: false });
  assert.equal(comparison.digest, digest(comparison.families));
});
