'use strict';

/**
 * Paired baseline/candidate calibration delta tests (#3414, slice 3308-P2).
 *
 * The contract group pins what has to be frozen before scoring: every field is
 * required, an unknown field is rejected, an unsupported bootstrap method is
 * rejected, and a non-finite number is a typed failure rather than a silent
 * default.
 *
 * The measurement group fixes the arithmetic. A candidate that states the true
 * outcome dominates a miscalibrated baseline, so the paired Brier delta is
 * positive and clears a locked meaningful effect; the reverse arm loses; an
 * identical arm has a zero mean. The bootstrap is seeded, so the same contract
 * reproduces the same interval.
 *
 * The fail-closed group proves the claim cannot be gamed: mismatched decision
 * sets and censored outcomes are REJECT, a sample below the locked minimum is
 * INSUFFICIENT with null numbers, a point estimate above the meaningful effect
 * still loses when its interval straddles zero, and a candidate whose Brier
 * improves while its ECE breaches the non-inferiority margin does not gain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAIRED_DELTA_SCHEMA_VERSION,
  PAIRED_STATUS,
  PAIRED_ERROR_CODES,
  DIRECTION,
  BOOTSTRAP_METHOD,
  PairedDeltaError,
  lockContract,
  pairedCalibrationDelta,
} = require('../lib/cognitive-lab-paired-delta');

const CONTRACT = Object.freeze({
  method: BOOTSTRAP_METHOD,
  seed: 7,
  resamples: 1000,
  confidenceLevel: 0.95,
  meaningfulEffect: 0.03,
  nonInferiorityMargin: 0.02,
  minimumSamples: 10,
  direction: DIRECTION,
});

const ENVELOPE = Object.freeze({
  maxTokensPerArm: 10_000,
  maxCallsPerArm: 1_000,
  unit: 'tokens',
  overrunPolicy: 'reject',
});

// The gain fixture: a candidate that states the outcome dominates a
// miscalibrated baseline, so the paired delta clears the locked effect.
function gainArms() {
  const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
  return {
    baseline: ids.map((decisionId, i) => observed({ decisionId, probability: 0.9, y: i % 2 })),
    candidate: ids.map((decisionId, i) => observed({ decisionId, probability: i % 2, y: i % 2 })),
  };
}

function observed({ decisionId, probability, y }) {
  return { decisionId, probability, y, status: 'observed' };
}

function arm(ids, probability, y) {
  return ids.map((decisionId) => observed({ decisionId, probability, y }));
}

function assertPairedError(code, fn) {
  assert.throws(fn, (error) => error instanceof PairedDeltaError && error.code === code);
}

test('the contract is locked whole: every field is required and returned frozen', () => {
  const locked = lockContract({ ...CONTRACT });
  assert.equal(locked.method, BOOTSTRAP_METHOD);
  assert.equal(locked.seed, 7);
  assert.equal(locked.minimumSamples, 10);
  assert.ok(Object.isFrozen(locked));
});

test('a contract field missing or unknown is rejected, never defaulted', () => {
  const missing = { ...CONTRACT };
  delete missing.seed;
  assertPairedError(PAIRED_ERROR_CODES.MISSING_FIELD, () => lockContract(missing));
  assertPairedError(PAIRED_ERROR_CODES.UNKNOWN_FIELD, () => lockContract({ ...CONTRACT, threshold: 0.5 }));
});

test('an unsupported bootstrap method is rejected by name', () => {
  assertPairedError(PAIRED_ERROR_CODES.UNSUPPORTED_METHOD, () => lockContract({ ...CONTRACT, method: 'bootstrap' }));
});

test('a non-finite or out-of-range contract number fails closed', () => {
  assertPairedError(PAIRED_ERROR_CODES.NON_FINITE_NUMBER, () => lockContract({ ...CONTRACT, confidenceLevel: NaN }));
  assertPairedError(PAIRED_ERROR_CODES.INVALID_FIELD, () => lockContract({ ...CONTRACT, confidenceLevel: 1 }));
  assertPairedError(PAIRED_ERROR_CODES.INVALID_FIELD, () => lockContract({ ...CONTRACT, resamples: 50 }));
  assertPairedError(PAIRED_ERROR_CODES.INVALID_FIELD, () => lockContract({ ...CONTRACT, seed: -1 }));
  assertPairedError(PAIRED_ERROR_CODES.INVALID_FIELD, () => lockContract({ ...CONTRACT, meaningfulEffect: -0.1 }));
  assertPairedError(PAIRED_ERROR_CODES.INVALID_FIELD, () => lockContract({ ...CONTRACT, minimumSamples: 2 }));
});

test('a candidate that states the outcome beats a miscalibrated baseline', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
  const baseline = ids.map((decisionId, i) => observed({ decisionId, probability: 0.9, y: i % 2 }));
  const candidate = ids.map((decisionId, i) => observed({ decisionId, probability: i % 2, y: i % 2 }));
  const report = pairedCalibrationDelta({ baseline, candidate, contract: CONTRACT });
  assert.equal(report.status, PAIRED_STATUS.MEASURED);
  assert.ok(Math.abs(report.delta.brier.mean - 0.41) < 1e-9);
  assert.ok(report.delta.brier.lower > CONTRACT.meaningfulEffect, 'the interval lower bound must clear the locked effect');
  assert.equal(report.gain, true);
  assert.equal(report.assertsGain, true);
  assert.equal(report.reason, 'paired_gain_measured');
  assert.equal(report.schemaVersion, PAIRED_DELTA_SCHEMA_VERSION);
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.delta));
});

test('swapping the arms turns the gain negative', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
  const miscalibrated = ids.map((decisionId, i) => observed({ decisionId, probability: 0.9, y: i % 2 }));
  const calibrated = ids.map((decisionId, i) => observed({ decisionId, probability: i % 2, y: i % 2 }));
  const report = pairedCalibrationDelta({ baseline: calibrated, candidate: miscalibrated, contract: CONTRACT });
  assert.equal(report.gain, false);
  assert.ok(Math.abs(report.delta.brier.mean + 0.41) < 1e-9);
  assert.equal(report.reason, 'interval_below_meaningful_effect');
});

test('an identical arm gains nothing', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `d${i}`);
  const armRecords = ids.map((decisionId, i) => observed({ decisionId, probability: 0.5, y: i % 2 }));
  const report = pairedCalibrationDelta({ baseline: armRecords, candidate: armRecords.map((r) => ({ ...r })), contract: CONTRACT });
  assert.equal(report.delta.brier.mean, 0);
  assert.equal(report.gain, false);
  assert.equal(report.reason, 'interval_below_meaningful_effect');
});

test('the seeded bootstrap is reproducible for one contract', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `d${i}`);
  const baseline = ids.map((decisionId, i) => observed({ decisionId, probability: 0.8, y: i % 2 }));
  const candidate = ids.map((decisionId, i) => observed({ decisionId, probability: i % 2 ? 0.6 : 0.2, y: i % 2 }));
  const first = pairedCalibrationDelta({ baseline, candidate, contract: CONTRACT });
  const second = pairedCalibrationDelta({ baseline, candidate, contract: CONTRACT });
  assert.equal(first.delta.brier.lower, second.delta.brier.lower);
  assert.equal(first.delta.brier.upper, second.delta.brier.upper);
});

test('a decision scored in only one arm is rejected, not silently dropped', () => {
  const baseline = arm(['a', 'b', 'c'], 0.5, 1);
  const candidate = arm(['a', 'b'], 0.5, 1);
  const report = pairedCalibrationDelta({ baseline, candidate, contract: CONTRACT });
  assert.equal(report.status, PAIRED_STATUS.REJECT);
  assert.equal(report.reason, 'unpaired_decisions');
  assert.equal(report.assertsGain, false);
});

test('a censored outcome in one arm breaks the pairing rather than scoring zero', () => {
  const baseline = arm(['a', 'b', 'c'], 0.5, 1);
  const candidate = arm(['a', 'b', 'c'], 0.5, 1);
  candidate[1] = { decisionId: 'b', probability: 0.5, y: null, status: 'censored' };
  const report = pairedCalibrationDelta({ baseline, candidate, contract: CONTRACT });
  assert.equal(report.status, PAIRED_STATUS.REJECT);
  assert.equal(report.reason, 'unpaired_decisions');
});

test('a sample below the locked minimum is INSUFFICIENT with no numbers', () => {
  const baseline = arm(Array.from({ length: 5 }, (_, i) => `d${i}`), 0.5, 1);
  const candidate = arm(Array.from({ length: 5 }, (_, i) => `d${i}`), 0.5, 1);
  const report = pairedCalibrationDelta({ baseline, candidate, contract: CONTRACT });
  assert.equal(report.status, PAIRED_STATUS.INSUFFICIENT);
  assert.equal(report.reason, 'sample_below_minimum');
  assert.equal(report.measurement.paired, 5);
  assert.equal(report.delta, null);
  assert.equal(report.assertsGain, false);
});

test('a point estimate above the effect still loses when its interval straddles zero', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
  // Per-pair deltas alternate +0.5 and -0.3, so the mean is +0.1 but the
  // interval is wide enough to include zero.
  const baseline = ids.map((decisionId, i) => observed({
    decisionId, probability: i % 2 ? 1 : Math.sqrt(0.2), y: 0,
  }));
  const candidate = ids.map((decisionId) => observed({ decisionId, probability: Math.sqrt(0.5), y: 0 }));
  const report = pairedCalibrationDelta({ baseline, candidate, contract: { ...CONTRACT, meaningfulEffect: 0.05 } });
  assert.equal(report.status, PAIRED_STATUS.MEASURED);
  assert.ok(report.delta.brier.mean > 0.05);
  assert.ok(report.delta.brier.lower <= 0.05, 'the interval lower bound must not clear the effect');
  assert.equal(report.gain, false);
  assert.equal(report.reason, 'interval_below_meaningful_effect');
});

test('a lower Brier that breaches the ECE non-inferiority margin does not gain', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `d${i}`);
  // Baseline: honest 0.5 everywhere on a balanced outcome, ECE 0, Brier 0.25.
  const baseline = ids.map((decisionId, i) => observed({ decisionId, probability: 0.5, y: i % 2 }));
  // Candidate: lower Brier but bin-wise miscalibrated, ECE 0.45.
  const candidate = ids.map((decisionId, i) => observed({ decisionId, probability: i % 2 ? 0.55 : 0.45, y: i % 2 }));
  const report = pairedCalibrationDelta({ baseline, candidate, contract: { ...CONTRACT, meaningfulEffect: 0 } });
  assert.ok(report.delta.brier.mean > 0, 'the candidate does improve Brier');
  assert.equal(report.delta.ece.nonInferior, false);
  assert.equal(report.gain, false);
  assert.equal(report.reason, 'non_inferiority_violated');
});

test('the same records may not be read twice as independent pairs', () => {
  const ids = ['a', 'b'];
  const baseline = [...arm(ids, 0.5, 1), ...arm(ids, 0.5, 1)];
  const candidate = arm(ids, 0.5, 1);
  // The duplicate baseline record maps to the same decision id, so the arm has
  // two decisions and the candidate has two: the pairing holds and the duplicate
  // does not inflate the paired count.
  const report = pairedCalibrationDelta({ baseline, candidate, contract: CONTRACT });
  assert.equal(report.measurement.baselineObserved, 2);
  assert.equal(report.status, PAIRED_STATUS.INSUFFICIENT);
});

test('a verified equal budget leaves the measured gain intact', () => {
  const { baseline, candidate } = gainArms();
  const report = pairedCalibrationDelta({
    baseline,
    candidate,
    contract: CONTRACT,
    budget: {
      envelope: ENVELOPE,
      baselineUsage: { tokens: 4_000, calls: 400 },
      candidateUsage: { tokens: 4_000, calls: 400 },
    },
  });
  assert.equal(report.status, PAIRED_STATUS.MEASURED);
  assert.equal(report.budget.status, 'MATCHED');
  assert.equal(report.gain, true);
  assert.equal(report.assertsGain, true);
});

test('a budget overrun cannot pass as a gain even when the interval clears the effect', () => {
  const { baseline, candidate } = gainArms();
  const report = pairedCalibrationDelta({
    baseline,
    candidate,
    contract: CONTRACT,
    budget: {
      envelope: ENVELOPE,
      baselineUsage: { tokens: 4_000, calls: 400 },
      candidateUsage: { tokens: 10_001, calls: 400 },
    },
  });
  assert.equal(report.status, PAIRED_STATUS.MEASURED);
  assert.equal(report.budget.status, 'REJECT');
  assert.equal(report.budget.reason, 'budget_overrun');
  assert.equal(report.gain, false);
  assert.equal(report.assertsGain, false);
  assert.equal(report.reason, 'budget_not_verified');
});

test('a budget mismatch cannot pass as a gain', () => {
  const { baseline, candidate } = gainArms();
  const report = pairedCalibrationDelta({
    baseline,
    candidate,
    contract: CONTRACT,
    budget: {
      envelope: ENVELOPE,
      baselineUsage: { tokens: 4_000, calls: 400 },
      candidateUsage: { tokens: 4_100, calls: 400 },
    },
  });
  assert.equal(report.budget.status, 'REJECT');
  assert.equal(report.budget.reason, 'budget_mismatch');
  assert.equal(report.gain, false);
});

test('an unreported side is UNKNOWN and cannot pass as a gain', () => {
  const { baseline, candidate } = gainArms();
  const report = pairedCalibrationDelta({
    baseline,
    candidate,
    contract: CONTRACT,
    budget: {
      envelope: ENVELOPE,
      baselineUsage: { tokens: 4_000, calls: 400 },
      candidateUsage: null,
    },
  });
  assert.equal(report.budget.status, 'UNKNOWN');
  assert.equal(report.gain, false);
});

test('omitting the budget keeps the prior paired-delta behaviour', () => {
  const { baseline, candidate } = gainArms();
  const report = pairedCalibrationDelta({ baseline, candidate, contract: CONTRACT });
  assert.equal(report.budget, null);
  assert.equal(report.gain, true);
});
