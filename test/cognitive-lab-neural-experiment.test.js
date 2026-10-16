'use strict';

// #3474 B7: the neural cognition experiment. Preregistered in
// docs/neural-cognition-r19.md with the frozen design
// fixtures/cognitive-lab/neural-cognition-design.json. Set HUQAN_B7_PRINT=1 to
// print the measured result as JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { contentHash } = require('../lib/content-hash');
const { digest } = require('../lib/causal/causal-episode-contract');
const { createLocalNeuralModel } = require('../lib/cognitive-model-local-ssm');
const { MODEL_AUTHORITY } = require('../lib/cognitive-model-port');
const {
  runNeuralCognitionExperiment, splitReport, overallStatus,
} = require('../lib/cognitive-lab-neural-experiment');
const { DESIGN, FROZEN, generateDataset } = require('../lib/cognitive-lab-neural-design');
const { main } = require('../bin/huqan-neural-lab');
const preregistered = require('../fixtures/cognitive-lab/neural-cognition-design.json');

const SHA = 'a'.repeat(40);
const create = (options) => createLocalNeuralModel(options);

test('the shipped design, inputs and environment law equal the preregistered frozen record', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DESIGN)), preregistered.design);
  assert.deepEqual({ ...FROZEN }, preregistered.frozen);
  assert.equal(digest(DESIGN), FROZEN.designDigest);
  assert.equal(digest(generateDataset()), FROZEN.fixtureDigest);
  const world = fs.readFileSync(path.join(__dirname, '..', 'lib/cognitive-lab-neural-world.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(contentHash(world), FROZEN.worldDigest);
});

test('a small unfrozen run is INSUFFICIENT yet reports honest B7 quality, budget and locality', () => {
  const small = { ...DESIGN, split: { train: { prefix: 'train', count: 40 }, holdout: { prefix: 'holdout', count: 40 }, transfer: { prefix: 'transfer', count: 40 } } };
  const result = runNeuralCognitionExperiment({ createModel: create, design: small, sourceCommit: SHA, sourceDirty: true });
  assert.equal(result.status, 'INSUFFICIENT');
  assert.equal(result.frozenInputsVerified, false);
  assert.equal(result.manifest.mechanisms.B7, 'ENABLED');
  assert.equal(result.automaticPromotion, false);
  assert.equal(result.model.authority, MODEL_AUTHORITY);
  assert.equal(result.model.canonical, false);
  assert.equal(result.locality.externalCalls, 0);
  assert.equal(result.budget.modelCalls, 0);
  assert.equal(result.budget.tokens, 0);
  assert.ok(result.budget.parameters > 0);
  for (const report of result.reports) {
    assert.equal(report.status, 'INSUFFICIENT');
    assert.equal(report.quality.calibration, 'NOT_MEASURED');
    assert.ok(report.cases.every((row) => row.authority === MODEL_AUTHORITY && row.canonical === false));
  }
});

test('a non-finite score, an invalid proposal or an untrained answer rejects an otherwise adequate split', () => {
  const row = { correct: 1, majorityCorrect: 0, memorylessCorrect: 0, falsePositive: 0, falseNegative: 0, confidence: 0.5,
    finiteScore: 1, valid: 1, authority: MODEL_AUTHORITY, canonical: false };
  const rows = (changes) => Array.from({ length: 320 }, (_, i) => (i === 0 ? { ...row, ...changes } : row));
  const thresholds = DESIGN.thresholds;
  assert.equal(splitReport('holdout', rows({}), thresholds).status, 'KEEP');
  assert.equal(splitReport('holdout', rows({ finiteScore: 0 }), thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({ valid: 0 }), thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({ authority: 'CANONICAL' }), thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({ canonical: true }), thresholds).status, 'REJECT');
  // A model that is wrong where the majority baseline is right is a real loss.
  const lost = Array.from({ length: 320 }, () => ({ ...row, correct: 0, majorityCorrect: 1, memorylessCorrect: 1 }));
  assert.equal(splitReport('holdout', lost, thresholds).status, 'REJECT');
  assert.equal(splitReport('holdout', rows({}).slice(1), thresholds).status, 'INSUFFICIENT');
  // A safety failure is never hidden behind a small sample.
  assert.equal(splitReport('holdout', rows({ finiteScore: 0 }).slice(0, 10), thresholds).status, 'REJECT');
});

test('the overall verdict lets any REJECT win and keeps KEEP for frozen inputs, frozen law and a clean source', () => {
  const keep = { status: 'KEEP' };
  const base = { reports: [keep, keep], frozenInputs: true, worldLaw: true, sourceDirty: false, equalExternalBudget: true };
  assert.equal(overallStatus(base), 'KEEP');
  assert.equal(overallStatus({ ...base, reports: [{ status: 'INSUFFICIENT' }, { status: 'REJECT' }] }), 'REJECT');
  assert.equal(overallStatus({ ...base, frozenInputs: false, reports: [keep, { status: 'REJECT' }] }), 'REJECT');
  assert.equal(overallStatus({ ...base, frozenInputs: false }), 'INSUFFICIENT');
  assert.equal(overallStatus({ ...base, worldLaw: false }), 'INSUFFICIENT');
  assert.equal(overallStatus({ ...base, sourceDirty: true }), 'INSUFFICIENT');
  assert.equal(overallStatus({ ...base, equalExternalBudget: false }), 'REJECT');
});

test('the frozen run KEEPs with a real quality gain and zero external cost, and is reproducible', () => {
  const first = runNeuralCognitionExperiment({ createModel: create, sourceCommit: SHA, sourceDirty: false });
  assert.equal(first.frozenInputsVerified, true);
  assert.equal(first.worldLawVerified, true);
  assert.equal(first.status, 'KEEP');
  for (const report of first.reports) {
    assert.equal(report.status, 'KEEP');
    assert.ok(report.quality.candidateAccuracy > report.quality.majorityAccuracy);
    assert.ok(report.quality.candidateAccuracy > report.quality.memorylessAccuracy);
    assert.ok(report.quality.gainVsMajority.lower95 > 0);
    assert.ok(report.quality.gainVsMemoryless.lower95 > 0);
  }
  const second = runNeuralCognitionExperiment({ createModel: create, sourceCommit: SHA, sourceDirty: false });
  assert.equal(digest(first.reports), digest(second.reports));
  assert.equal(first.manifestDigest, second.manifestDigest);
  if (process.env.HUQAN_B7_PRINT === '1') process.stdout.write(`${JSON.stringify(first)}\n`);
});

test('the runner refuses missing provenance, a foreign design and overlapping splits before training', () => {
  assert.throws(() => runNeuralCognitionExperiment({ createModel: create }), /source commit/);
  assert.throws(() => runNeuralCognitionExperiment({ createModel: create, sourceCommit: SHA }), /source dirty/);
  assert.throws(() => runNeuralCognitionExperiment({ sourceCommit: SHA, sourceDirty: false }), /model constructor/);
  assert.throws(() => runNeuralCognitionExperiment({ createModel: create, sourceCommit: SHA, sourceDirty: false, design: { ...DESIGN, world: 'other' } }), /design/);
  const dataset = generateDataset();
  const overlapping = { ...dataset, splits: [{ name: 'holdout', cases: dataset.train }, dataset.splits[1]] };
  assert.throws(() => runNeuralCognitionExperiment({ createModel: create, sourceCommit: SHA, sourceDirty: false, dataset: overlapping }), /overlapping/);
});

test('the installed CLI exposes B7 and validates its arguments without opening memory', () => {
  assert.match(main(['--help']).usage, /--benchmark B7/);
  assert.equal(main(['--help']).benchmarks.B7, DESIGN.scope);
  assert.deepEqual(main(['--help']).modelKinds, ['SSM', 'RWKV', 'MAMBA', 'TRANSFORMER']);
  assert.throws(() => main(['--benchmark', 'B7']), /explicit/);
  assert.throws(() => main(['--benchmark', 'B7', '--source-commit', 'x', '--source-dirty', 'false']), /explicit/);
});

test('the CLI selects a model family and compares all four without opening memory', () => {
  const rwkv = main(['--benchmark', 'B7', '--model-kind', 'RWKV', '--source-commit', SHA, '--source-dirty', 'false']);
  assert.equal(rwkv.model.kind, 'RWKV');
  assert.equal(rwkv.status, 'KEEP');
  const comparison = main(['--compare', '--source-commit', SHA, '--source-dirty', 'false']);
  assert.deepEqual(comparison.families.map((family) => family.kind).sort(), ['MAMBA', 'RWKV', 'SSM', 'TRANSFORMER']);
  assert.equal(comparison.automaticPromotion, false);
  assert.throws(() => main(['--model-kind', 'LSTM', '--source-commit', SHA, '--source-dirty', 'false']), /--model-kind/);
});
