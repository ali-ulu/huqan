'use strict';

/**
 * R50 PR4 — simulated abstention policy for the contradiction sensor
 * (issue #3582, roadmap R50).
 *
 * This is a simulation, not production wiring: it turns a calibrated
 * probability into a three-band decision so PR4 can measure what a policy
 * *would* do on the frozen holdout. No runtime module imports it, no candidate
 * is blocked or promoted, and `NO_DETECTED_CONTRADICTION` never means the two
 * claims are compatible -- only that the calibrated probability stayed low.
 *
 * The band edges are locked before a single decision is classified, and the
 * policy is fail-closed: if any guard is missing or inconsistent (no calibration
 * artifact, a digest mismatch, an unknown feature spec, a detector-source digest
 * mismatch, insufficient calibration support, or a non-finite score) every
 * decision is `ABSTAIN` with the reason recorded. A guard failure can never
 * silently degrade to a confident band.
 */

const { isPlainObject } = require('./is-plain-object');
const { computeCalibrationDigest } = require('./cognitive-lab-contradiction-calibrator');
const { FEATURE_SPEC_DIGEST } = require('./cognitive-lab-contradiction-features');

const POLICY_SCHEMA_VERSION = 'huqan-contradiction-policy-v1';

const POLICY_BAND = Object.freeze({
  NO_DETECTED_CONTRADICTION: 'NO_DETECTED_CONTRADICTION',
  ABSTAIN: 'ABSTAIN',
  CONTRADICTION_REVIEW_CANDIDATE: 'CONTRADICTION_REVIEW_CANDIDATE',
});

const ABSTAIN_REASONS = Object.freeze({
  CALIBRATION_ARTIFACT_MISSING: 'calibration_artifact_missing',
  CALIBRATION_DIGEST_MISMATCH: 'calibration_digest_mismatch',
  UNKNOWN_FEATURE_SPEC: 'unknown_feature_spec',
  DETECTOR_SOURCE_DIGEST_MISMATCH: 'detector_source_digest_mismatch',
  INSUFFICIENT_CALIBRATION_SUPPORT: 'insufficient_calibration_support',
  NON_FINITE_SCORE: 'non_finite_score',
  UNKNOWN_BAND: 'unknown_band',
});

const POLICY_ERROR_CODES = Object.freeze({
  INVALID_THRESHOLDS: 'policy_invalid_thresholds',
  INVALID_INPUT: 'policy_invalid_input',
});

class ContradictionPolicyError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'ContradictionPolicyError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new ContradictionPolicyError(code, path, message);
}

/**
 * Lock the band edges. `low` and `high` are closed-form thresholds on a
 * calibrated probability, so they are validated before any decision is made.
 */
function lockThresholds(thresholds = {}) {
  const low = thresholds.low;
  const high = thresholds.high;
  for (const [name, value] of [['low', low], ['high', high]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      fail(POLICY_ERROR_CODES.INVALID_THRESHOLDS, `thresholds.${name}`, 'band edge must be a finite probability in [0, 1]');
    }
  }
  if (!(low <= high)) fail(POLICY_ERROR_CODES.INVALID_THRESHOLDS, 'thresholds', 'low must not exceed high');
  return Object.freeze({ low, high });
}

/**
 * Check every fail-closed guard and return the abstain reasons (empty when the
 * policy is allowed to classify).
 */
function policyGuardReasons(guards = {}) {
  const reasons = [];
  const artifact = guards.calibrationArtifact;
  if (!isPlainObject(artifact)) {
    reasons.push(ABSTAIN_REASONS.CALIBRATION_ARTIFACT_MISSING);
  } else if (computeCalibrationDigest(artifact) !== artifact.digest) {
    reasons.push(ABSTAIN_REASONS.CALIBRATION_DIGEST_MISMATCH);
  }
  if (guards.calibrationStatus !== undefined && guards.calibrationStatus !== 'MEASURED') {
    reasons.push(ABSTAIN_REASONS.INSUFFICIENT_CALIBRATION_SUPPORT);
  }
  const fusionArtifact = guards.fusionArtifact;
  if (isPlainObject(fusionArtifact) && fusionArtifact.featureSpecDigest !== FEATURE_SPEC_DIGEST) {
    reasons.push(ABSTAIN_REASONS.UNKNOWN_FEATURE_SPEC);
  }
  const expected = guards.expectedDetectorDigests;
  if (isPlainObject(expected) && isPlainObject(fusionArtifact) && isPlainObject(fusionArtifact.detectorSourceDigests)) {
    for (const [name, digest] of Object.entries(expected)) {
      if (fusionArtifact.detectorSourceDigests[name] !== digest) {
        reasons.push(ABSTAIN_REASONS.DETECTOR_SOURCE_DIGEST_MISMATCH);
        break;
      }
    }
  }
  return Object.freeze(reasons);
}

/**
 * Classify one calibrated probability into a band.
 *
 * @param {number} probability a calibrated probability in [0, 1]
 * @param {{low:number, high:number}} thresholds locked band edges
 */
function policyBand(probability, thresholds) {
  if (typeof probability !== 'number' || !Number.isFinite(probability)) {
    return Object.freeze({ band: POLICY_BAND.ABSTAIN, reason: ABSTAIN_REASONS.NON_FINITE_SCORE });
  }
  if (probability < thresholds.low) return Object.freeze({ band: POLICY_BAND.NO_DETECTED_CONTRADICTION, reason: null });
  if (probability >= thresholds.high) return Object.freeze({ band: POLICY_BAND.CONTRADICTION_REVIEW_CANDIDATE, reason: null });
  return Object.freeze({ band: POLICY_BAND.ABSTAIN, reason: 'middle_band_review' });
}

/**
 * Simulate the policy over a set of decisions. Every guard reason forces the
 * whole run to `ABSTAIN`; otherwise each record is classified by its calibrated
 * probability.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.records holdout records
 * @param {(record:object) => number} input.probabilityOf calibrated probability
 * @param {{low:number, high:number}} input.thresholds locked band edges
 * @param {object} input.guards fail-closed evidence bundle
 * @returns {Readonly<object>} the band distribution, per-decision rows and the
 *   guard reasons; `productionWiring: false` and `autoBlock: false` are fixed.
 */
function simulateContradictionPolicy({ records, probabilityOf, thresholds, guards = {} } = {}) {
  if (!Array.isArray(records)) fail(POLICY_ERROR_CODES.INVALID_INPUT, 'records', 'records must be an array');
  if (typeof probabilityOf !== 'function') fail(POLICY_ERROR_CODES.INVALID_INPUT, 'probabilityOf', 'probabilityOf must be a function');
  const locked = lockThresholds(thresholds);
  const reasons = policyGuardReasons(guards);
  const distribution = { NO_DETECTED_CONTRADICTION: 0, ABSTAIN: 0, CONTRADICTION_REVIEW_CANDIDATE: 0 };
  const decisions = [];
  for (const record of records) {
    let band;
    let reason;
    if (reasons.length > 0) {
      band = POLICY_BAND.ABSTAIN;
      reason = reasons[0];
    } else {
      const probability = probabilityOf(record);
      const classified = policyBand(probability, locked);
      band = classified.band;
      reason = classified.reason;
    }
    distribution[band] += 1;
    decisions.push(Object.freeze({
      pairId: record.pairId,
      split: record.split,
      label: record.label,
      band,
      reason,
    }));
  }
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    thresholds: locked,
    guards: Object.freeze({ passed: reasons.length === 0, reasons }),
    distribution: Object.freeze(distribution),
    decisions: Object.freeze(decisions),
    productionWiring: false,
    autoBlock: false,
    autoReject: false,
    autoPromotion: false,
    assertsGain: false,
  });
}

module.exports = {
  POLICY_SCHEMA_VERSION,
  POLICY_BAND,
  ABSTAIN_REASONS,
  POLICY_ERROR_CODES,
  ContradictionPolicyError,
  lockThresholds,
  policyGuardReasons,
  policyBand,
  simulateContradictionPolicy,
};
