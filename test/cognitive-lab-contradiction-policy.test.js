'use strict';

// R50 PR4 (issue #3582): the simulated abstention policy. These tests lock the
// properties that keep it a simulation and fail-closed:
//
//   - the band edges are validated before a decision is classified;
//   - a low calibrated probability is NO_DETECTED_CONTRADICTION and never means
//     the claims are compatible;
//   - the middle band and any missing/inconsistent guard ABSTAIN;
//   - a digest mismatch, an unknown feature spec, a detector-source mismatch,
//     insufficient calibration support and a non-finite score all abstain;
//   - no production wiring, no auto-block/reject/promotion.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  POLICY_BAND, ABSTAIN_REASONS, POLICY_ERROR_CODES, ContradictionPolicyError,
  lockThresholds, policyBand, policyGuardReasons, simulateContradictionPolicy,
} = require('../lib/cognitive-lab-contradiction-policy.js');
const { fitCalibration } = require('../lib/cognitive-lab-contradiction-calibrator.js');
const { contradictionRuleScore, joinCorpusLabels } = require('../lib/cognitive-lab-contradiction-evaluator.js');

const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8'));
const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.labels.json'), 'utf8'));
const CONTRACT = Object.freeze({ minimumSamples: 10, smoothingAlpha: 0.5 });
const THRESHOLDS = Object.freeze({ low: 0.35, high: 0.65 });

function artifact() {
  const records = joinCorpusLabels(CORPUS, LABELS)
    .filter((record) => record.split === 'calibration')
    .map((record) => ({ decisionId: record.pairId, split: 'calibration', score: contradictionRuleScore(record).score, label: record.label }));
  return fitCalibration({ records, contract: CONTRACT }).artifact;
}

function holdout() {
  return joinCorpusLabels(CORPUS, LABELS).filter((record) => record.split === 'holdout');
}

// --- thresholds -------------------------------------------------------------

test('the band edges are locked and an inverted or out-of-range pair is refused', () => {
  assert.deepEqual(lockThresholds(THRESHOLDS), { low: 0.35, high: 0.65 });
  assert.throws(() => lockThresholds({ low: 0.8, high: 0.2 }),
    (error) => error instanceof ContradictionPolicyError && error.code === POLICY_ERROR_CODES.INVALID_THRESHOLDS);
  assert.throws(() => lockThresholds({ low: -0.1, high: 0.5 }),
    (error) => error instanceof ContradictionPolicyError && error.code === POLICY_ERROR_CODES.INVALID_THRESHOLDS);
});

// --- band semantics ---------------------------------------------------------

test('a low probability is NO_DETECTED_CONTRADICTION, the middle band abstains, a high one is a review candidate', () => {
  assert.equal(policyBand(0.1, THRESHOLDS).band, POLICY_BAND.NO_DETECTED_CONTRADICTION);
  assert.equal(policyBand(0.5, THRESHOLDS).band, POLICY_BAND.ABSTAIN);
  assert.equal(policyBand(0.9, THRESHOLDS).band, POLICY_BAND.CONTRADICTION_REVIEW_CANDIDATE);
  // Boundaries: low is inclusive of the middle band, high is inclusive of the top.
  assert.equal(policyBand(0.35, THRESHOLDS).band, POLICY_BAND.ABSTAIN);
  assert.equal(policyBand(0.65, THRESHOLDS).band, POLICY_BAND.CONTRADICTION_REVIEW_CANDIDATE);
});

test('NO_DETECTED_CONTRADICTION is a low-probability band, not a compatibility claim', () => {
  const result = simulateContradictionPolicy({
    records: holdout(), probabilityOf: () => 0.05, thresholds: THRESHOLDS,
    guards: { calibrationArtifact: artifact(), calibrationStatus: 'MEASURED' },
  });
  assert.equal(result.distribution.NO_DETECTED_CONTRADICTION, holdout().length);
  assert.equal(result.productionWiring, false);
  assert.equal(result.autoBlock, false);
  assert.equal(result.autoReject, false);
  assert.equal(result.autoPromotion, false);
});

// --- fail-closed guards -----------------------------------------------------

test('a missing calibration artifact abstains for every decision', () => {
  const result = simulateContradictionPolicy({
    records: holdout(), probabilityOf: () => 0.9, thresholds: THRESHOLDS, guards: {},
  });
  assert.equal(result.distribution.ABSTAIN, holdout().length);
  assert.deepEqual(result.guards.reasons, [ABSTAIN_REASONS.CALIBRATION_ARTIFACT_MISSING]);
});

test('a tampered calibration digest abstains', () => {
  const tampered = { ...artifact(), digest: 'f'.repeat(64) };
  const result = simulateContradictionPolicy({
    records: holdout(), probabilityOf: () => 0.9, thresholds: THRESHOLDS,
    guards: { calibrationArtifact: tampered, calibrationStatus: 'MEASURED' },
  });
  assert.equal(result.distribution.ABSTAIN, holdout().length);
  assert.deepEqual(result.guards.reasons, [ABSTAIN_REASONS.CALIBRATION_DIGEST_MISMATCH]);
});

test('an unknown feature spec, a detector-source mismatch and insufficient support each abstain', () => {
  const calibrationArtifact = artifact();
  const base = { calibrationArtifact, calibrationStatus: 'MEASURED' };
  assert.deepEqual(policyGuardReasons({ ...base, fusionArtifact: { featureSpecDigest: 'x' } }),
    [ABSTAIN_REASONS.UNKNOWN_FEATURE_SPEC]);
  assert.deepEqual(policyGuardReasons({
    ...base,
    fusionArtifact: { featureSpecDigest: require('../lib/cognitive-lab-contradiction-features.js').FEATURE_SPEC_DIGEST, detectorSourceDigests: { 'a.js': 'd1' } },
    expectedDetectorDigests: { 'a.js': 'd2' },
  }), [ABSTAIN_REASONS.DETECTOR_SOURCE_DIGEST_MISMATCH]);
  assert.deepEqual(policyGuardReasons({ ...base, calibrationStatus: 'INSUFFICIENT' }),
    [ABSTAIN_REASONS.INSUFFICIENT_CALIBRATION_SUPPORT]);
});

test('a non-finite calibrated score abstains rather than banding', () => {
  const result = simulateContradictionPolicy({
    records: holdout(), probabilityOf: () => Number.NaN, thresholds: THRESHOLDS,
    guards: { calibrationArtifact: artifact(), calibrationStatus: 'MEASURED' },
  });
  assert.equal(result.distribution.ABSTAIN, holdout().length);
  assert.equal(result.decisions[0].reason, ABSTAIN_REASONS.NON_FINITE_SCORE);
});
