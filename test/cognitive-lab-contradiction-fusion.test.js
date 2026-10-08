'use strict';

// R50 PR3 (issue #3582): the deterministic local fusion arm. These tests lock
// the properties that keep arm C a closed-form local readout rather than a model:
//
//   - the feature set is frozen and label-blind: split/label/pairId edits do not
//     move a feature, and the vector has exactly the pinned width;
//   - the readout is trained on the train split only and its raw output is a
//     score, never a probability (probability only enters via calibration);
//   - the artifact is deterministic and digest-bound, and a tampered artifact is
//     refused on read;
//   - the authority boundary is DETERMINISTIC/LOCAL/CANDIDATE_ONLY with zero
//     model calls, tokens or external calls;
//   - too little train support is INSUFFICIENT, never a fit.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const features = require('../lib/cognitive-lab-contradiction-features.js');
const fusion = require('../lib/cognitive-lab-contradiction-fusion.js');

const {
  FEATURE_ORDER, FEATURE_SPEC_DIGEST, FIRED_RULES, extractFeatures, ContradictionFeaturesError,
} = features;
const {
  FUSION_STATUS, AUTHORITY, MIN_TRAIN_SAMPLES, ContradictionFusionError,
  fitFusion, fusionScore, fusionProbability, computeFusionDigest,
} = fusion;

const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8'));
const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.labels.json'), 'utf8'));
const CONTRACT = Object.freeze({ minimumSamples: 10, smoothingAlpha: 0.5 });
const COMMIT = 'a'.repeat(40);

const { fitCalibration } = require('../lib/cognitive-lab-contradiction-calibrator.js');
const { contradictionRuleScore } = require('../lib/cognitive-lab-contradiction-evaluator.js');

function joinedRecords() {
  return CORPUS.records.map((record) => ({
    pairId: record.pairId,
    split: record.split,
    stored: record.stored,
    incoming: record.incoming,
    label: LABELS.labels[record.pairId] && LABELS.labels[record.pairId].label,
  }));
}

function calibrationArtifact() {
  const records = joinedRecords()
    .filter((record) => record.split === 'calibration')
    .map((record) => ({ decisionId: record.pairId, split: 'calibration', score: contradictionRuleScore(record).score, label: record.label }));
  return fitCalibration({ records, contract: CONTRACT }).artifact;
}

function fitFrozen() {
  const records = joinedRecords();
  return fitFusion({
    trainRecords: records.filter((record) => record.split === 'train'),
    calibrationRecords: records.filter((record) => record.split === 'calibration'),
    calibrationArtifact: calibrationArtifact(),
    sourceCommit: COMMIT,
  });
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => (error instanceof ContradictionFusionError || error instanceof ContradictionFeaturesError) && error.code === code, `expected ${code}`);
}

// --- feature contract -------------------------------------------------------

test('the feature vector is the pinned width and every entry is finite', () => {
  const { vector, named } = extractFeatures(CORPUS.records[0]);
  assert.equal(vector.length, FEATURE_ORDER.length);
  assert.equal(vector.length, FIRED_RULES.length + 9);
  for (const value of vector) assert.ok(Number.isFinite(value));
  assert.equal(typeof named.sameSubject, 'number');
});

test('the feature vector ignores split, label, pairId and reviewer identity', () => {
  const base = CORPUS.records.find((record) => LABELS.labels[record.pairId]);
  const plain = extractFeatures(base);
  const edited = extractFeatures({
    ...base, pairId: 'pair:rewritten', split: 'holdout',
    label: base.label === 'CONTRADICTION' ? 'NOT_CONTRADICTION' : 'CONTRADICTION',
    reviewer: 'someone-else', candidateId: 'x', path: '/tmp/x',
  });
  assert.deepEqual([...plain.vector], [...edited.vector]);
});

test('the feature spec digest pins the name/order list', () => {
  assert.match(FEATURE_SPEC_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(FEATURE_SPEC_DIGEST, require('../lib/hash-chain').sha256Hex(
    require('../lib/hash-chain').stableStringify({ version: 'huqan-contradiction-features-v1', order: FEATURE_ORDER })));
});

test('a malformed record is rejected, not silently featurized', () => {
  throwsCode(() => extractFeatures(null), 'features_invalid_record');
});

// --- fit is train-only and deterministic ------------------------------------

test('the fusion artifact is deterministic and digest-bound', () => {
  const first = fitFrozen();
  const second = fitFrozen();
  assert.equal(first.status, FUSION_STATUS.MEASURED);
  assert.equal(first.artifact.digest, second.artifact.digest);
  assert.equal(first.artifact.digest, computeFusionDigest(first.artifact));
  assert.equal(first.artifact.training.readout.length, FEATURE_ORDER.length + 1);
});

test('a tampered fusion artifact is refused on read', () => {
  const fit = fitFrozen();
  const tampered = { ...fit.artifact, training: { ...fit.artifact.training, readout: fit.artifact.training.readout.map(() => 0) } };
  throwsCode(() => fusionScore(tampered, CORPUS.records[0]), 'fusion_digest_mismatch');
});

test('too little train support is INSUFFICIENT, never a fit', () => {
  const records = joinedRecords();
  const result = fitFusion({
    trainRecords: records.filter((record) => record.split === 'train').slice(0, MIN_TRAIN_SAMPLES - 1),
    calibrationRecords: records.filter((record) => record.split === 'calibration'),
    calibrationArtifact: calibrationArtifact(),
    sourceCommit: COMMIT,
  });
  assert.equal(result.status, FUSION_STATUS.INSUFFICIENT);
  assert.equal(result.artifact, null);
});

test('a missing source commit or a bad ridge is refused', () => {
  const records = joinedRecords();
  throwsCode(() => fitFusion({
    trainRecords: records.filter((record) => record.split === 'train'),
    calibrationRecords: records.filter((record) => record.split === 'calibration'),
    calibrationArtifact: calibrationArtifact(),
  }), 'fusion_invalid_input');
  throwsCode(() => fitFusion({
    trainRecords: records.filter((record) => record.split === 'train'),
    calibrationRecords: records.filter((record) => record.split === 'calibration'),
    calibrationArtifact: calibrationArtifact(), sourceCommit: COMMIT, ridge: -1,
  }), 'fusion_invalid_ridge');
});

// --- score, not probability -------------------------------------------------

test('the raw fusion output is a score; probability only comes from calibration', () => {
  const fit = fitFrozen();
  const artifact = calibrationArtifact();
  const record = CORPUS.records.find((row) => LABELS.labels[row.pairId] && LABELS.labels[row.pairId].label === 'CONTRADICTION');
  const score = fusionScore(fit.artifact, record);
  const probability = fusionProbability(fit.artifact, record, artifact);
  assert.ok(Number.isFinite(score));
  assert.ok(probability >= 0 && probability <= 1);
  // The score itself is not clamped to [0,1]; only the calibrated readout is.
  assert.equal(probability, require('../lib/cognitive-lab-contradiction-calibrator.js').applyCalibration(artifact, score));
});

// --- authority boundary -----------------------------------------------------

test('the fusion result keeps the deterministic/local/candidate-only boundary', () => {
  const fit = fitFrozen();
  assert.deepEqual(fit.authority, AUTHORITY);
  assert.equal(fit.authority.kind, 'DETERMINISTIC');
  assert.equal(fit.authority.canonical, false);
  assert.equal(fit.authority.modelCalls, 0);
  assert.equal(fit.authority.tokens, 0);
  assert.equal(fit.authority.externalCalls, 0);
});
