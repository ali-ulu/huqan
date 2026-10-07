'use strict';

/**
 * R50 PR2 — contradiction-arm evaluator (issue #3582, roadmap key R50).
 *
 * The frozen corpus (PR1) carries claims only. This module turns a corpus record
 * into the deterministic rule signal the product already produces
 * (`runContradictionRules`) and scores one arm's decisions against the human
 * labels. It owns no model and no store: it is a pure function over records.
 *
 * Two arms share the same detector coverage and the same raw rule score:
 *
 *   A  the declared heuristic confidence (`0.90/0.95`) is read as if it were an
 *      outcome probability; `probabilityKind = DECLARED_HEURISTIC`, so Brier/ECE
 *      are deliberately not reported for it;
 *   B  the same raw score mapped through a frozen calibration artifact fit on the
 *      calibration split; `probabilityKind = CALIBRATED`, so Brier/ECE are real.
 *
 * The evaluator isolates the contradiction-only signal subset -- it calls the
 * contradiction rules, never the risk rules -- and keeps `UNCERTAIN` and
 * `INVALID_PAIR` as explicit exclusions rather than turning them into binary
 * failures. A detector is scored on the pairs where it fired; a decision is
 * scored on the pairs whose label is scorable.
 *
 * The metric surface is measured, not asserted: precision/recall/FPR/coverage
 * are reported for the binary decision, Brier/ECE only when a real frozen
 * pre-outcome probability exists, and `assertsGain` is always false here. A gain
 * is a paired claim and belongs to PR4.
 */

const { runContradictionRules } = require('./contradiction-rules');
const { isPlainObject } = require('./is-plain-object');
const { calibrate, ELEVEN_BINS, MIN_OBSERVED_RECORDS } = require('./cognitive-lab-probability-calibration');
const { applyCalibration, fitCalibration, CALIBRATOR_STATUS } = require('./cognitive-lab-contradiction-calibrator');

const EVALUATOR_SCHEMA_VERSION = 'huqan-contradiction-evaluator-v1';

const EVALUATOR_STATUS = Object.freeze({
  MEASURED: 'MEASURED',
  INSUFFICIENT: 'INSUFFICIENT',
});

const PROBABILITY_KIND = Object.freeze({
  DECLARED_HEURISTIC: 'DECLARED_HEURISTIC',
  CALIBRATED: 'CALIBRATED',
});

const SCORABLE_LABELS = Object.freeze(['CONTRADICTION', 'NOT_CONTRADICTION']);

// The frozen rule order is the repo's own `runContradictionRules` order; the
// preregistration pins it so a reordering is a visible contract change.
const RULE_ORDER = Object.freeze([
  'NUMERICAL_CONFLICT',
  'VALUE_CONFLICT',
  'TYPE_CONFLICT',
  'NEGATION_CONFLICT',
  'UNIT_CONFLICT',
  'CAUSE_PREVENT_OPPOSITION',
  'SEMANTIC_OPPOSITION',
  'RELATION_INVERSION',
  'PREDICATE_DRIFT',
]);

const EVALUATOR_ERROR_CODES = Object.freeze({
  INVALID_RECORD: 'evaluator_invalid_record',
  INVALID_ARM: 'evaluator_invalid_arm',
  INVALID_THRESHOLD: 'evaluator_invalid_threshold',
  NON_FINITE_PREDICTION: 'evaluator_non_finite_prediction',
});

class ContradictionEvaluatorError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'ContradictionEvaluatorError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new ContradictionEvaluatorError(code, path, message);
}

function requireThreshold(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(EVALUATOR_ERROR_CODES.INVALID_THRESHOLD, 'threshold', 'threshold must be a number in [0, 1]');
  }
  return value;
}

function requireRecord(record, index) {
  const at = `records[${index}]`;
  if (!isPlainObject(record)) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, at, `${at} must be an object`);
  if (typeof record.pairId !== 'string' || !record.pairId.trim()) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, `${at}.pairId`, 'pairId is required');
  if (typeof record.split !== 'string' || !record.split.trim()) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, `${at}.split`, 'split is required');
  if (typeof record.label !== 'string' || !record.label.trim()) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, `${at}.label`, 'label is required');
  return record;
}

/**
 * Run the contradiction-only detectors over one corpus record. The risk rules
 * are deliberately not called: a risk signal must not leak into this benchmark.
 *
 * @returns {Readonly<{ score:number, signalCount:number, rules:ReadonlyArray<string>, maxSeverity:number, evidenceCount:number }>}
 *   `score` is the maximum declared confidence across fired signals (0 when none
 *   fired). It is a raw rule score, never a probability.
 */
function contradictionRuleScore(record) {
  const signals = runContradictionRules(record.stored, record.incoming);
  let score = 0;
  let maxSeverity = 0;
  let evidenceCount = 0;
  const rules = [];
  for (const signal of signals) {
    const confidence = Number(signal.confidence);
    if (Number.isFinite(confidence)) score = Math.max(score, confidence);
    const severity = Number(signal.severity);
    if (Number.isFinite(severity)) maxSeverity = Math.max(maxSeverity, severity);
    evidenceCount += Array.isArray(signal.evidence) ? signal.evidence.length : 0;
    if (typeof signal.rule === 'string') rules.push(signal.rule);
  }
  return Object.freeze({
    score,
    signalCount: signals.length,
    rules: Object.freeze(rules),
    maxSeverity,
    evidenceCount,
  });
}

/**
 * Arm A: the declared heuristic confidence read as a probability. The value is
 * labelled `DECLARED_HEURISTIC` so a reader cannot mistake it for a calibrated
 * outcome probability.
 */
function armADeclared(record) {
  const { score } = contradictionRuleScore(record);
  return Object.freeze({ score, probability: score, probabilityKind: PROBABILITY_KIND.DECLARED_HEURISTIC });
}

/**
 * Arm B: the same raw rule score mapped through the frozen calibration artifact.
 * The artifact digest is verified inside `applyCalibration`; a tampered mapping
 * is rejected rather than silently scoring.
 */
function armBCalibrated(record, artifact) {
  const { score } = contradictionRuleScore(record);
  return Object.freeze({ score, probability: applyCalibration(artifact, score), probabilityKind: PROBABILITY_KIND.CALIBRATED });
}

function toCalibrationRecords(scored) {
  return scored.map((entry) => Object.freeze({
    decisionId: entry.pairId,
    status: 'observed',
    probability: entry.probability,
    y: entry.y,
  }));
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Score one arm over the frozen records.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.records corpus records (claims + split + label)
 * @param {(record:object) => {score:number, probability:number, probabilityKind:string}} input.predict
 * @param {number} input.threshold decision threshold on the arm's probability
 * @param {ReadonlyArray<number>} [input.bins] reliability bin edges
 * @param {number} [input.minObserved] Brier/ECE sample floor
 * @returns {Readonly<object>} a `MEASURED`/`INSUFFICIENT` arm report with the
 *   confusion matrix, discrimination metrics, exclusions and (for a real
 *   probability) Brier/ECE. `assertsGain` is always false.
 */
function evaluateContradictionArm({ records, predict, threshold, bins = ELEVEN_BINS, minObserved = MIN_OBSERVED_RECORDS } = {}) {
  if (!Array.isArray(records)) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, 'records', 'records must be an array');
  if (typeof predict !== 'function') fail(EVALUATOR_ERROR_CODES.INVALID_ARM, 'predict', 'predict must be a function');
  const lockedThreshold = requireThreshold(threshold);

  const exclusions = { UNCERTAIN: 0, INVALID_PAIR: 0 };
  const decisions = [];
  let contradiction = 0;
  let notContradiction = 0;
  for (const [index, record] of records.entries()) {
    requireRecord(record, index);
    if (record.label === 'UNCERTAIN') { exclusions.UNCERTAIN += 1; continue; }
    if (record.label === 'INVALID_PAIR') { exclusions.INVALID_PAIR += 1; continue; }
    if (!SCORABLE_LABELS.includes(record.label)) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, `records[${index}].label`, `unknown label ${record.label}`);
    const prediction = predict(record);
    if (!isPlainObject(prediction)) fail(EVALUATOR_ERROR_CODES.INVALID_ARM, `predict(${record.pairId})`, 'predict must return an object');
    const probability = prediction.probability;
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      fail(EVALUATOR_ERROR_CODES.NON_FINITE_PREDICTION, `predict(${record.pairId}).probability`, 'predicted probability must be finite and in [0, 1]');
    }
    const y = record.label === 'CONTRADICTION' ? 1 : 0;
    if (y === 1) contradiction += 1; else notContradiction += 1;
    const predicted = probability >= lockedThreshold ? 1 : 0;
    decisions.push(Object.freeze({
      pairId: record.pairId,
      split: record.split,
      label: record.label,
      y,
      score: prediction.score,
      probability,
      probabilityKind: prediction.probabilityKind,
      predicted,
    }));
  }

  const confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const decision of decisions) {
    if (decision.y === 1 && decision.predicted === 1) confusion.tp += 1;
    else if (decision.y === 0 && decision.predicted === 1) confusion.fp += 1;
    else if (decision.y === 0 && decision.predicted === 0) confusion.tn += 1;
    else confusion.fn += 1;
  }
  const positives = confusion.tp + confusion.fn;
  const negatives = confusion.fp + confusion.tn;
  const metrics = Object.freeze({
    precision: ratio(confusion.tp, confusion.tp + confusion.fp),
    recall: ratio(confusion.tp, positives),
    falsePositiveRate: ratio(confusion.fp, negatives),
    coverage: ratio(confusion.tp + confusion.fp, decisions.length),
    predictedPositive: confusion.tp + confusion.fp,
  });

  const measurement = Object.freeze({
    threshold: lockedThreshold,
    support: decisions.length,
    contradiction,
    notContradiction,
    exclusions: Object.freeze({ ...exclusions }),
  });

  const probabilityKind = decisions.length > 0 ? decisions[0].probabilityKind : null;
  // A declared heuristic confidence is not a pre-outcome probability, so Brier
  // and ECE are withheld rather than reported as if they measured calibration.
  const calibration = probabilityKind === PROBABILITY_KIND.CALIBRATED
    ? calibrate(toCalibrationRecords(decisions), { bins, minObserved })
    : null;

  return Object.freeze({
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    status: decisions.length >= minObserved ? EVALUATOR_STATUS.MEASURED : EVALUATOR_STATUS.INSUFFICIENT,
    probabilityKind,
    measurement,
    confusion: Object.freeze(confusion),
    metrics,
    calibration,
    decisions: Object.freeze(decisions),
    assertsGain: false,
  });
}

/**
 * Join the frozen corpus (claims + split) with the frozen labels by `pairId`.
 * A corpus pair with no label is a hard failure: a silently dropped pair would
 * shrink the measurement, and a silently defaulted one would invent ground truth.
 */
function joinCorpusLabels(corpus, labels) {
  if (!isPlainObject(corpus) || !Array.isArray(corpus.records)) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, 'corpus.records', 'corpus.records must be an array');
  if (!isPlainObject(labels) || !isPlainObject(labels.labels)) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, 'labels.labels', 'labels.labels must be an object');
  return corpus.records.map((record, index) => {
    const entry = labels.labels[record.pairId];
    if (!isPlainObject(entry) || typeof entry.label !== 'string') {
      fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, `corpus.records[${index}]`, `no label for ${record.pairId}`);
    }
    return Object.freeze({
      pairId: record.pairId,
      split: record.split,
      stored: record.stored,
      incoming: record.incoming,
      label: entry.label,
    });
  });
}

/**
 * Run the PR2 A/B measurement over joined evaluation records.
 *
 * Arm B's calibration artifact is fit only on the calibration split (the fitter
 * refuses any other split), then A and B are scored on the same frozen holdout.
 * The returned decisions are the paired input PR4 compares.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.records joined records `{ pairId, split, stored, incoming, label }`
 * @param {object} input.contract calibrator contract `{ minimumSamples, smoothingAlpha }`
 * @param {number} [input.threshold] decision threshold for both arms
 */
function runContradictionRecords({ records, contract, threshold = 0.5, bins = ELEVEN_BINS, minObserved = MIN_OBSERVED_RECORDS } = {}) {
  if (!Array.isArray(records) || records.length === 0) fail(EVALUATOR_ERROR_CODES.INVALID_RECORD, 'records', 'records must be a non-empty array');
  const calibrationRecords = records
    .filter((record) => record.split === 'calibration')
    .map((record) => Object.freeze({ decisionId: record.pairId, split: record.split, score: contradictionRuleScore(record).score, label: record.label }));
  const fit = fitCalibration({ records: calibrationRecords, contract });
  if (fit.status !== CALIBRATOR_STATUS.MEASURED) {
    return Object.freeze({
      schemaVersion: EVALUATOR_SCHEMA_VERSION,
      status: EVALUATOR_STATUS.INSUFFICIENT,
      reason: 'calibration_insufficient',
      contract: fit.contract,
      calibrator: fit,
      arms: null,
      assertsGain: false,
    });
  }
  const holdout = records.filter((record) => record.split === 'holdout');
  const armA = evaluateContradictionArm({ records: holdout, predict: armADeclared, threshold, bins, minObserved });
  const armB = evaluateContradictionArm({ records: holdout, predict: (record) => armBCalibrated(record, fit.artifact), threshold, bins, minObserved });
  return Object.freeze({
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    status: armA.status === EVALUATOR_STATUS.MEASURED && armB.status === EVALUATOR_STATUS.MEASURED
      ? EVALUATOR_STATUS.MEASURED : EVALUATOR_STATUS.INSUFFICIENT,
    reason: 'measured',
    contract: fit.contract,
    calibrator: fit,
    arms: Object.freeze({ A: armA, B: armB }),
    assertsGain: false,
  });
}

/** Corpus+labels convenience wrapper over `runContradictionRecords`. */
function runContradictionBaseline({ corpus, labels, contract, threshold = 0.5, bins = ELEVEN_BINS, minObserved = MIN_OBSERVED_RECORDS } = {}) {
  return runContradictionRecords({ records: joinCorpusLabels(corpus, labels), contract, threshold, bins, minObserved });
}

module.exports = {
  EVALUATOR_SCHEMA_VERSION,
  EVALUATOR_STATUS,
  PROBABILITY_KIND,
  SCORABLE_LABELS,
  RULE_ORDER,
  EVALUATOR_ERROR_CODES,
  ContradictionEvaluatorError,
  contradictionRuleScore,
  armADeclared,
  armBCalibrated,
  evaluateContradictionArm,
  joinCorpusLabels,
  runContradictionRecords,
  runContradictionBaseline,
};
