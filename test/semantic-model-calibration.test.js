'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stableStringify, sha256Hex } = require('../lib/hash-chain');
const { LABELS } = require('../lib/semantic-model-artifact');
const { loadSemanticModel } = require('../lib/semantic-model-inference');
const { fitCalibration, loadCalibration, applyCalibration, MIN_CALIBRATION_RECORDS } = require('../lib/semantic-model-calibration');

const MODEL = `sha256:${'d'.repeat(64)}`;
const CORPUS = `sha256:${'e'.repeat(64)}`;
const reseal = ({ calibrationDigest, ...payload }) => ({ ...payload, calibrationDigest: `sha256:${sha256Hex(stableStringify(payload))}` });

/** Well separated but under-confident: the right class always leads by a small raw margin. */
function synthetic(n) {
  const predictions = [];
  const labels = [];
  for (let i = 0; i < n; i++) {
    const right = i % 3;
    const rawScores = [0.3, 0.3, 0.3, 0.01].map((score, k) => k === right ? 0.42 : score);
    const sum = rawScores.reduce((total, score) => total + score, 0);
    predictions.push({ rawScores, artifactDigest: MODEL, family: 'SSM',
      distribution: Object.fromEntries(LABELS.map((label, k) => [label, rawScores[k] / sum])) });
    labels.push(LABELS[i % 10 === 9 ? (right + 1) % 3 : right]);
  }
  return { predictions, labels };
}

test('same calibration input replays a byte-identical artifact', () => {
  const { predictions, labels } = synthetic(60);
  const a = fitCalibration(predictions, labels, { calibrationCorpusDigest: CORPUS });
  const b = fitCalibration(structuredClone(predictions), [...labels], { calibrationCorpusDigest: CORPUS });
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(a.modelArtifactDigest, MODEL);
  assert.equal(a.calibrationCorpusDigest, CORPUS);
});

test('a well-separated calibration set lowers top-label ECE and leaves confident predictions', () => {
  const { predictions, labels } = synthetic(60);
  const calibration = fitCalibration(predictions, labels, { calibrationCorpusDigest: CORPUS });
  assert.equal(calibration.status, 'fitted');
  assert.ok(calibration.metrics.ece < calibration.uncalibratedMetrics.ece);
  assert.ok(calibration.metrics.brier < calibration.uncalibratedMetrics.brier);
  assert.ok(calibration.params.temperature < 1);
  const applied = applyCalibration(predictions[0], calibration);
  assert.equal(applied.label, 'CONTRADICTION');
  assert.equal(applied.band, 'CONFIDENT');
  assert.equal(applied.calibrated, true);
  assert.equal(applied.calibrationDigest, calibration.calibrationDigest);
  assert.ok(Math.abs(Object.values(applied.distribution).reduce((sum, p) => sum + p, 0) - 1) < 1e-9);
});

test('random labels keep every calibrated prediction inside the ABSTAIN band', () => {
  const { predictions } = synthetic(60);
  const labels = predictions.map((_, i) => LABELS[(i * 7 + 1) % 3]);
  const calibration = fitCalibration(predictions, labels, { calibrationCorpusDigest: CORPUS });
  assert.equal(calibration.abstainBand.upper, 1);
  for (const prediction of predictions) assert.equal(applyCalibration(prediction, calibration).band, 'ABSTAIN');
});

test('insufficient calibration data is recorded as such and always abstains', () => {
  const { predictions, labels } = synthetic(MIN_CALIBRATION_RECORDS - 1);
  const calibration = fitCalibration(predictions, labels, { calibrationCorpusDigest: CORPUS });
  assert.equal(calibration.status, 'insufficient');
  assert.equal(calibration.params.temperature, 1);
  for (const prediction of predictions) {
    const applied = applyCalibration(prediction, calibration);
    assert.equal(applied.band, 'ABSTAIN');
    assert.equal(applied.reason, 'calibration_insufficient');
  }
  assert.throws(() => fitCalibration(predictions, labels, { calibrationCorpusDigest: CORPUS, minRecords: 10 }),
    /semantic_calibration_min_records_invalid/);
});

test('loading fails closed with a coded TypeError for every tampering case', () => {
  const { predictions, labels } = synthetic(60);
  const calibration = structuredClone(fitCalibration(predictions, labels, { calibrationCorpusDigest: CORPUS }));
  const load = (value, model = MODEL) => () => loadCalibration(value, { modelArtifactDigest: model });
  assert.deepEqual(loadCalibration(JSON.stringify(calibration), { modelArtifactDigest: MODEL }), calibration);
  const cases = [
    [load({ ...calibration, metrics: { ...calibration.metrics, ece: 0.5 } }), 'semantic_calibration_digest_mismatch'],
    [load(calibration, `sha256:${'0'.repeat(64)}`), 'semantic_calibration_model_mismatch'],
    [() => loadCalibration(calibration), 'semantic_calibration_model_mismatch'],
    [load(reseal({ ...calibration, schemaVersion: 'v0' })), 'semantic_calibration_spec_unknown'],
    [load(reseal({ ...calibration, method: 'isotonic' })), 'semantic_calibration_spec_unknown'],
    [load(reseal({ ...calibration, params: { ...calibration.params, temperature: Infinity } })), 'semantic_calibration_params_invalid'],
    [load(reseal({ ...calibration, params: { ...calibration.params, temperature: null } })), 'semantic_calibration_params_invalid'],
    [load(reseal({ ...calibration, abstainBand: { lower: 0.9, upper: 0.1 } })), 'semantic_calibration_params_invalid'],
    [load(reseal({ ...calibration, extra: true })), 'semantic_calibration_fields_invalid'],
    [load(' '.repeat(64 * 1024 + 1)), 'semantic_calibration_budget_exceeded'],
  ];
  for (const [fn, code] of cases) assert.throws(fn, error => error instanceof TypeError && error.message === code, code);
  const foreign = { ...predictions[0], artifactDigest: `sha256:${'1'.repeat(64)}` };
  assert.throws(() => applyCalibration(foreign, calibration), /semantic_calibration_model_mismatch/);
  assert.throws(() => fitCalibration([foreign, predictions[0]], labels.slice(0, 2), { calibrationCorpusDigest: CORPUS }),
    /semantic_calibration_model_mixed/);
  assert.throws(() => fitCalibration(predictions, labels.map(() => 'MAYBE'), { calibrationCorpusDigest: CORPUS }),
    /semantic_calibration_label_invalid/);
});

const DATASET = path.join(__dirname, 'fixtures/semantic-training-v1/training-dataset.json');
const { calibrateSemanticModel, main } = require('../scripts/calibrate-semantic-model');
const { digestOf } = require('../scripts/contradiction-eval-freeze-contract');

test('packaged calibrations replay byte-identically and honestly abstain on the 22-record split', () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  for (const family of ['ssm', 'rwkv', 'mamba', 'transformer']) {
    const modelText = fs.readFileSync(path.join(__dirname, `../lib/semantic-model-artifacts/${family}.json`), 'utf8');
    const packaged = fs.readFileSync(path.join(__dirname, `../lib/semantic-model-artifacts/${family}.calibration.json`), 'utf8');
    const replay = calibrateSemanticModel(dataset, modelText);
    assert.equal(`${stableStringify(replay)}\n`, packaged.replace(/\r\n/g, '\n'));
    assert.equal(replay.status, 'insufficient');
    assert.equal(replay.metrics.n, 22);
    const model = loadSemanticModel(modelText);
    const record = dataset.records.find(r => r.split === 'calibration');
    assert.equal(applyCalibration(model.predict(record), loadCalibration(packaged, { modelArtifactDigest: model.artifactDigest })).band, 'ABSTAIN');
  }
});

test('the script refuses R50 holdout records and never overwrites an output', () => {
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const holdout = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8'))
    .records.find(record => record.split === 'holdout');
  const { corpusDigest, ...payload } = dataset;
  const leaked = { ...payload, records: [...payload.records, { ...dataset.records[0], stored: holdout.stored, incoming: holdout.incoming }] };
  const modelText = fs.readFileSync(path.join(__dirname, '../lib/semantic-model-artifacts/ssm.json'), 'utf8');
  assert.throws(() => calibrateSemanticModel({ ...leaked, corpusDigest: `sha256:${digestOf(leaked)}` }, modelText), /semantic_holdout_leakage/);
  const relabeled = { ...payload, records: payload.records.map((r, i) => i === 0 ? { ...r, split: 'holdout' } : r) };
  assert.throws(() => calibrateSemanticModel({ ...relabeled, corpusDigest: `sha256:${digestOf(relabeled)}` }, modelText), /semantic_holdout_leakage/);
  assert.throws(() => calibrateSemanticModel({ ...dataset, corpusDigest: 'changed' }, modelText), /digest_mismatch/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-calibration-'));
  try {
    const out = path.join(dir, 'out.json');
    const model = path.join(__dirname, '../lib/semantic-model-artifacts/ssm.json');
    assert.match(main([DATASET, model, out]), /^sha256:[a-f0-9]{64}$/);
    assert.throws(() => main([DATASET, model, out]), /EEXIST/);
    assert.throws(() => main([DATASET, model]), /usage/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
