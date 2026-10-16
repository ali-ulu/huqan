'use strict';

// R50 PR2 (issue #3582): the calibrator turns a raw rule score into a frozen
// P(contradiction). These tests lock the properties that make the mapping a
// measurement rather than a fitted-to-taste curve:
//
//   - the fit reads the calibration split only; train/holdout input is refused;
//   - the mapping is deterministic and digest-bound, so the same records always
//     reproduce the same bytes;
//   - the mapping is monotone: a higher score can never claim a lower
//     contradiction probability;
//   - too little support is INSUFFICIENT, never a number;
//   - a malformed or non-finite score is rejected, not silently scored;
//   - a tampered artifact is rejected on read.

const assert = require('node:assert/strict');
const test = require('node:test');

const calibrator = require('../lib/cognitive-lab-contradiction-calibrator.js');

const {
  CALIBRATOR_STATUS, CALIBRATOR_ERROR_CODES, MIN_CALIBRATION_SAMPLES,
  ContradictionCalibratorError, fitCalibration, applyCalibration, computeCalibrationDigest,
} = calibrator;

const CONTRACT = Object.freeze({ minimumSamples: 10, smoothingAlpha: 0.5 });

function record(decisionId, score, label, split = 'calibration') {
  return { decisionId, split, score, label };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ContradictionCalibratorError && error.code === code, `expected ${code}`);
}

// --- leakage guard ----------------------------------------------------------

test('the fitter refuses any split that is not the calibration split', () => {
  throwsCode(() => fitCalibration({ records: [record('d1', 0.9, 'CONTRADICTION', 'holdout')], contract: CONTRACT }),
    CALIBRATOR_ERROR_CODES.FIT_SPLIT_NOT_CALIBRATION);
  throwsCode(() => fitCalibration({ records: [record('d1', 0.9, 'CONTRADICTION', 'train')], contract: CONTRACT }),
    CALIBRATOR_ERROR_CODES.FIT_SPLIT_NOT_CALIBRATION);
});

test('a duplicate decision in the fit input is rejected', () => {
  const records = [
    record('d1', 0.9, 'CONTRADICTION'),
    record('d1', 0.9, 'CONTRADICTION'),
  ];
  throwsCode(() => fitCalibration({ records, contract: CONTRACT }), CALIBRATOR_ERROR_CODES.DUPLICATE_DECISION);
});

// --- determinism ------------------------------------------------------------

test('the same calibration records reproduce the same artifact digest', () => {
  const records = [
    record('a', 0, 'CONTRADICTION'), record('b', 0, 'NOT_CONTRADICTION'),
    record('c', 0, 'CONTRADICTION'), record('d', 0, 'NOT_CONTRADICTION'),
    record('e', 0, 'CONTRADICTION'), record('f', 0, 'NOT_CONTRADICTION'),
    record('g', 0.9, 'CONTRADICTION'), record('h', 0.9, 'CONTRADICTION'),
    record('i', 0.95, 'NOT_CONTRADICTION'), record('j', 0.95, 'CONTRADICTION'),
  ];
  const first = fitCalibration({ records, contract: CONTRACT });
  const second = fitCalibration({ records: [...records].reverse(), contract: CONTRACT });
  assert.equal(first.status, CALIBRATOR_STATUS.MEASURED);
  assert.equal(first.artifact.digest, second.artifact.digest);
  assert.equal(first.artifact.digest, computeCalibrationDigest(first.artifact));
});

// --- monotonicity -----------------------------------------------------------

test('the calibrated probability never decreases as the score rises', () => {
  const records = [
    // deliberately noisy: a high score with a low rate must be pooled down.
    record('a', 0, 'CONTRADICTION'), record('b', 0, 'CONTRADICTION'),
    record('c', 0.5, 'NOT_CONTRADICTION'), record('d', 0.5, 'NOT_CONTRADICTION'),
    record('e', 0.9, 'NOT_CONTRADICTION'), record('f', 0.9, 'NOT_CONTRADICTION'),
    record('g', 1, 'CONTRADICTION'), record('h', 1, 'CONTRADICTION'),
    record('i', 1, 'CONTRADICTION'), record('j', 1, 'CONTRADICTION'),
  ];
  const fit = fitCalibration({ records, contract: CONTRACT });
  assert.equal(fit.status, CALIBRATOR_STATUS.MEASURED);
  let previous = -Infinity;
  for (const point of fit.artifact.points) {
    assert.ok(point.probability >= previous, `score ${point.score} dropped below the previous point`);
    previous = point.probability;
  }
});

// --- sufficiency ------------------------------------------------------------

test('scorable support below the floor is INSUFFICIENT, never a number', () => {
  const records = Array.from({ length: MIN_CALIBRATION_SAMPLES - 1 }, (_, index) => record(`d${index}`, 0.9, 'CONTRADICTION'));
  const fit = fitCalibration({ records, contract: CONTRACT });
  assert.equal(fit.status, CALIBRATOR_STATUS.INSUFFICIENT);
  assert.equal(fit.artifact, null);
  assert.equal(fit.reason, 'sample_below_minimum');
});

test('UNCERTAIN and INVALID_PAIR are excluded, not counted as support', () => {
  const records = [
    ...Array.from({ length: 10 }, (_, index) => record(`c${index}`, 0.9, 'CONTRADICTION')),
    record('u', 0.9, 'UNCERTAIN'), record('v', 0.9, 'INVALID_PAIR'),
  ];
  const fit = fitCalibration({ records, contract: CONTRACT });
  assert.equal(fit.status, CALIBRATOR_STATUS.MEASURED);
  assert.equal(fit.measurement.scorable, 10);
  assert.equal(fit.measurement.excluded, 2);
});

// --- malformed input --------------------------------------------------------

test('a non-finite score is rejected before it can be fit', () => {
  throwsCode(() => fitCalibration({ records: [record('a', Number.NaN, 'CONTRADICTION')], contract: CONTRACT }),
    CALIBRATOR_ERROR_CODES.NON_FINITE_SCORE);
  throwsCode(() => fitCalibration({ records: [record('a', Infinity, 'CONTRADICTION')], contract: CONTRACT }),
    CALIBRATOR_ERROR_CODES.NON_FINITE_SCORE);
});

test('an unknown contract field or a missing field is rejected', () => {
  throwsCode(() => fitCalibration({ records: [], contract: { minimumSamples: 10, smoothingAlpha: 0.5, extra: 1 } }),
    CALIBRATOR_ERROR_CODES.UNKNOWN_FIELD);
  throwsCode(() => fitCalibration({ records: [], contract: { minimumSamples: 10 } }),
    CALIBRATOR_ERROR_CODES.MISSING_FIELD);
  throwsCode(() => fitCalibration({ records: [], contract: { minimumSamples: 1, smoothingAlpha: 0.5 } }),
    CALIBRATOR_ERROR_CODES.INVALID_FIELD);
});

// --- readout ----------------------------------------------------------------

test('a tampered artifact is rejected on read', () => {
  const records = Array.from({ length: 10 }, (_, index) => record(`d${index}`, index % 2, 'CONTRADICTION'));
  const fit = fitCalibration({ records, contract: CONTRACT });
  const tampered = { ...fit.artifact, points: fit.artifact.points.map((point) => ({ ...point, probability: 1 })) };
  throwsCode(() => applyCalibration(tampered, 0.5), CALIBRATOR_ERROR_CODES.DIGEST_MISMATCH);
});

test('the readout is a frozen monotone step/interpolation over the fitted points', () => {
  const records = [
    record('a', 0, 'CONTRADICTION'), record('b', 0, 'CONTRADICTION'), record('c', 0, 'NOT_CONTRADICTION'),
    record('d', 1, 'CONTRADICTION'), record('e', 1, 'CONTRADICTION'), record('f', 1, 'CONTRADICTION'),
    record('g', 1, 'CONTRADICTION'), record('h', 1, 'CONTRADICTION'), record('i', 1, 'NOT_CONTRADICTION'),
    record('j', 1, 'CONTRADICTION'),
  ];
  const fit = fitCalibration({ records, contract: CONTRACT });
  const low = applyCalibration(fit.artifact, 0);
  const high = applyCalibration(fit.artifact, 1);
  const mid = applyCalibration(fit.artifact, 0.5);
  assert.ok(low < high);
  assert.ok(mid >= low && mid <= high);
  // Out-of-range scores clamp to the nearest point rather than extrapolating.
  assert.equal(applyCalibration(fit.artifact, -1), low);
  assert.equal(applyCalibration(fit.artifact, 2), high);
});
