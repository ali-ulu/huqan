'use strict';

/**
 * R50 PR4 — the A/B/C evidence report (issue #3582, roadmap R50).
 *
 * PR2 measured A and B, PR3 added C. This module is the preregistered
 * comparison: the three arms on the same frozen holdout, the same scorable
 * decisions, with the paired C-vs-B delta as the primary claim. Beating A alone
 * is not enough -- fusion must add measurable value over the calibration-only
 * baseline B -- so the primary comparison is C vs B, run through the existing
 * paired seeded-bootstrap machinery (`lib/cognitive-lab-paired-delta.js`) with a
 * contract locked before a single delta is computed.
 *
 * Brier/ECE are reported only where a real frozen pre-outcome probability
 * exists: arms B and C. Arm A's declared heuristic confidence is not a
 * calibrated probability, so it contributes discrimination metrics only and its
 * Brier/ECE stay absent. A weakness profile is produced *after* measurement and
 * every per-detector claim is support-gated: below the floor the report says
 * `INSUFFICIENT_FOR_DETECTOR_CLAIM` instead of a number.
 *
 * The valid final states are MEANINGFUL_IMPROVEMENT, NO_MEANINGFUL_IMPROVEMENT,
 * REGRESSION and INSUFFICIENT. C losing is a valid outcome: the measurement may
 * reject fusion (`FUSION_REJECTED_BY_MEASUREMENT`) and R50 still closes. No
 * production wiring, no promotion, no authority change.
 */

const { isPlainObject } = require('./is-plain-object');
const { stableStringify, sha256Hex } = require('./hash-chain');
const {
  PAIRED_STATUS, DIRECTION, pairedCalibrationDelta,
} = require('./cognitive-lab-paired-delta');
const {
  EVALUATOR_STATUS, PROBABILITY_KIND, RULE_ORDER,
  contradictionRuleScore, evaluateContradictionArm, armADeclared, armBCalibrated, joinCorpusLabels,
} = require('./cognitive-lab-contradiction-evaluator');
const { fitCalibration, CALIBRATOR_STATUS, applyCalibration } = require('./cognitive-lab-contradiction-calibrator');
const { fitFusion, FUSION_STATUS, fusionScore } = require('./cognitive-lab-contradiction-fusion');
const { simulateContradictionPolicy } = require('./cognitive-lab-contradiction-policy');
const { ELEVEN_BINS, MIN_OBSERVED_RECORDS } = require('./cognitive-lab-probability-calibration');

const REPORT_SCHEMA_VERSION = 'huqan-contradiction-report-v1';

const FINAL_STATE = Object.freeze({
  MEANINGFUL_IMPROVEMENT: 'MEANINGFUL_IMPROVEMENT',
  NO_MEANINGFUL_IMPROVEMENT: 'NO_MEANINGFUL_IMPROVEMENT',
  REGRESSION: 'REGRESSION',
  INSUFFICIENT: 'INSUFFICIENT',
  FUSION_REJECTED_BY_MEASUREMENT: 'FUSION_REJECTED_BY_MEASUREMENT',
});

const REPORT_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'report_invalid_input',
  NO_HOLDOUT: 'report_no_holdout',
});

// The comparison contract is locked before any delta is computed. The effect
// size and non-inferiority margin are the preregistration's decision rule; a
// caller may pass a stricter contract but the defaults are the frozen ones.
const DEFAULT_REPORT_CONTRACT = Object.freeze({
  method: 'seeded-paired-bootstrap',
  seed: 3582,
  resamples: 2000,
  confidenceLevel: 0.95,
  meaningfulEffect: 0.02,
  nonInferiorityMargin: 0.02,
  minimumSamples: MIN_OBSERVED_RECORDS,
  direction: DIRECTION,
});

const MIN_DETECTOR_SUPPORT = 5;

// Simulation-only band edges on the calibrated probability (preregistration
// §5's low/middle/high split). Locked here, before any holdout decision is
// classified, and never wired into a runtime path.
const DEFAULT_POLICY_THRESHOLDS = Object.freeze({ low: 0.35, high: 0.65 });

class ContradictionReportError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'ContradictionReportError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new ContradictionReportError(code, path, message);
}

function scorable(record) {
  return record.label === 'CONTRADICTION' || record.label === 'NOT_CONTRADICTION';
}

function toCalibrationRecords(decisions) {
  return decisions.map((decision) => Object.freeze({
    decisionId: decision.pairId, status: 'observed', probability: decision.probability, y: decision.y,
  }));
}

/**
 * Support-gated per-detector weakness profile. Produced after measurement; a
 * detector with fewer than `MIN_DETECTOR_SUPPORT` fired scorable holdout pairs
 * gets `INSUFFICIENT_FOR_DETECTOR_CLAIM` rather than a ratio.
 */
function weaknessProfile(records, { bins = ELEVEN_BINS, minObserved = MIN_OBSERVED_RECORDS } = {}) {
  const scorableRecords = records.filter(scorable);
  const profile = [];
  for (const rule of RULE_ORDER) {
    const fired = scorableRecords.filter((record) => contradictionRuleScore(record).rules.includes(rule));
    const entry = {
      rule,
      support: fired.length,
      precision: null, recall: null, falsePositiveRate: null, coverage: null,
      brier: null, ece: null,
      sourceType: {}, frame: {},
    };
    for (const record of fired) {
      const storedType = (record.stored && record.stored.sourceType) || 'unknown';
      const frame = (record.stored && record.stored.frameId) || 'unknown';
      entry.sourceType[storedType] = (entry.sourceType[storedType] || 0) + 1;
      entry.frame[frame] = (entry.frame[frame] || 0) + 1;
    }
    if (fired.length < MIN_DETECTOR_SUPPORT) {
      entry.claim = 'INSUFFICIENT_FOR_DETECTOR_CLAIM';
      profile.push(Object.freeze(entry));
      continue;
    }
    const tp = fired.filter((record) => record.label === 'CONTRADICTION').length;
    const fp = fired.length - tp;
    const positives = scorableRecords.filter((record) => record.label === 'CONTRADICTION').length;
    const negatives = scorableRecords.length - positives;
    entry.precision = tp / (tp + fp);
    entry.recall = positives === 0 ? null : tp / positives;
    entry.falsePositiveRate = negatives === 0 ? null : fp / negatives;
    entry.coverage = fired.length / scorableRecords.length;
    // Brier/ECE only where a real calibrated probability exists: the detector's
    // own signal has none, so the profile leaves them null and reports ratios.
    entry.claim = 'MEASURED';
    profile.push(Object.freeze(entry));
  }
  return Object.freeze(profile);
}

function finalStateFor(primary) {
  if (primary.status !== PAIRED_STATUS.MEASURED) return FINAL_STATE.INSUFFICIENT;
  if (primary.gain) return FINAL_STATE.MEANINGFUL_IMPROVEMENT;
  if (primary.delta.brier.mean < 0) return FINAL_STATE.REGRESSION;
  return FINAL_STATE.NO_MEANINGFUL_IMPROVEMENT;
}

/**
 * Build the preregistered A/B/C report on the frozen holdout.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.records joined records `{ pairId, split, stored, incoming, label }`
 * @param {object} input.contract calibrator contract `{ minimumSamples, smoothingAlpha }`
 * @param {object} [input.reportContract] the locked comparison contract
 * @param {number} [input.threshold] decision threshold for the arms
 * @param {string} input.sourceCommit 40-char Git SHA pinning the fusion artifact
 * @param {object} [input.budget] optional paired equal-budget evidence
 */
function runContradictionReport({ records, contract, reportContract, threshold = 0.5, bins = ELEVEN_BINS, minObserved = MIN_OBSERVED_RECORDS, sourceCommit, budget, policyThresholds = DEFAULT_POLICY_THRESHOLDS } = {}) {
  if (!Array.isArray(records) || records.length === 0) fail(REPORT_ERROR_CODES.INVALID_INPUT, 'records', 'records must be a non-empty array');
  const comparisonContract = Object.freeze({ ...DEFAULT_REPORT_CONTRACT, ...(reportContract || {}) });
  const calibrationRecords = records
    .filter((record) => record.split === 'calibration')
    .map((record) => Object.freeze({ decisionId: record.pairId, split: record.split, score: contradictionRuleScore(record).score, label: record.label }));
  const fit = fitCalibration({ records: calibrationRecords, contract });
  if (fit.status !== CALIBRATOR_STATUS.MEASURED) {
    return Object.freeze({
      schemaVersion: REPORT_SCHEMA_VERSION,
      status: EVALUATOR_STATUS.INSUFFICIENT,
      reason: 'calibration_insufficient',
      finalState: FINAL_STATE.INSUFFICIENT,
      arms: null,
      comparison: null,
      weakness: null,
      assertsGain: false,
      productionBehaviorChanged: false,
    });
  }
  const holdout = records.filter((record) => record.split === 'holdout');
  if (holdout.length === 0) fail(REPORT_ERROR_CODES.NO_HOLDOUT, 'records', 'no holdout records to evaluate');

  const armA = evaluateContradictionArm({ records: holdout, predict: armADeclared, threshold, bins, minObserved });
  const armB = evaluateContradictionArm({ records: holdout, predict: (record) => armBCalibrated(record, fit.artifact), threshold, bins, minObserved });

  const fusion = fitFusion({
    trainRecords: records.filter((record) => record.split === 'train'),
    calibrationRecords: records.filter((record) => record.split === 'calibration'),
    calibrationArtifact: fit.artifact,
    sourceCommit,
  });
  if (fusion.status !== FUSION_STATUS.MEASURED) {
    return Object.freeze({
      schemaVersion: REPORT_SCHEMA_VERSION,
      status: EVALUATOR_STATUS.INSUFFICIENT,
      reason: 'fusion_insufficient',
      finalState: FINAL_STATE.INSUFFICIENT,
      arms: Object.freeze({ A: armA, B: armB }),
      comparison: null,
      weakness: null,
      assertsGain: false,
      productionBehaviorChanged: false,
    });
  }
  const armC = evaluateContradictionArm({
    records: holdout,
    predict: (record) => Object.freeze({
      score: fusionScore(fusion.artifact, record),
      probability: applyCalibration(fit.artifact, fusionScore(fusion.artifact, record)),
      probabilityKind: PROBABILITY_KIND.CALIBRATED,
    }),
    threshold, bins, minObserved,
  });

  const primary = pairedCalibrationDelta({
    baseline: toCalibrationRecords(armB.decisions),
    candidate: toCalibrationRecords(armC.decisions),
    contract: comparisonContract,
    budget,
  });

  // Simulation-only policy: it classifies the holdout through the C arm's
  // calibrated probability but wires nothing. The guards bundle the frozen
  // evidence so a missing/mismatched artifact abstains instead of banding.
  const policy = simulateContradictionPolicy({
    records: holdout,
    probabilityOf: (record) => applyCalibration(fit.artifact, fusionScore(fusion.artifact, record)),
    thresholds: policyThresholds,
    guards: {
      calibrationArtifact: fit.artifact,
      calibrationStatus: fit.status,
      fusionArtifact: fusion.artifact,
    },
  });

  const evidence = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    corpusDigest: sha256Hex(stableStringify(records.map((record) => `${record.pairId}:${record.split}:${record.label}`))),
    calibratorDigest: fit.artifact.digest,
    fusionDigest: fusion.artifact.digest,
    primaryDelta: primary.status === PAIRED_STATUS.MEASURED
      ? { mean: primary.delta.brier.mean, lower: primary.delta.brier.lower, upper: primary.delta.brier.upper } : null,
  };
  const weakness = weaknessProfile(holdout, { bins, minObserved });
  const finalState = finalStateFor(primary);
  return Object.freeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: EVALUATOR_STATUS.MEASURED,
    reason: 'measured',
    finalState,
    fusionRejected: finalState === FINAL_STATE.NO_MEANINGFUL_IMPROVEMENT || finalState === FINAL_STATE.REGRESSION,
    arms: Object.freeze({ A: armA, B: armB, C: armC }),
    comparison: Object.freeze({
      primary: Object.freeze({ baseline: 'B', candidate: 'C', delta: primary }),
      contract: comparisonContract,
      note: 'beating A alone is not the claim; the primary comparison is C vs B',
    }),
    policy,
    weakness,
    evidenceDigest: sha256Hex(stableStringify(evidence)),
    assertsGain: primary.assertsGain,
    productionBehaviorChanged: false,
    automaticPromotion: false,
  });
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  FINAL_STATE,
  REPORT_ERROR_CODES,
  DEFAULT_REPORT_CONTRACT,
  DEFAULT_POLICY_THRESHOLDS,
  MIN_DETECTOR_SUPPORT,
  ContradictionReportError,
  weaknessProfile,
  runContradictionReport,
};
