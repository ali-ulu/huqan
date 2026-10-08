'use strict';

/**
 * Contradiction rule-baseline evaluator (#3582, R50 PR2).
 *
 * Scores the current deterministic contradiction detectors against the frozen
 * ground-truth corpus and returns the two baseline arms the preregistration
 * fixes:
 *
 *   A  the detector's current coverage with its DECLARED_HEURISTIC confidence
 *   B  the same coverage with a score -> P(contradiction) mapping fitted on the
 *      calibration split only (see `cognitive-lab-contradiction-calibrator.js`)
 *
 * Two rules are load-bearing and enforced here rather than assumed:
 *
 * - `UNCERTAIN` and `INVALID_PAIR` labels never enter the binary confusion
 *   matrix. They are reported as exclusion counts, not silently turned into a
 *   wrong prediction.
 * - Risk signals never reach this measurement. The evaluator runs
 *   `runContradictionRules` -- the contradiction-only rule set -- so the
 *   contradiction benchmark cannot be contaminated by `runRiskRules`.
 *
 * Only the calibration split is read to fit the mapping; the holdout is scored,
 * never fitted. The result is candidate-only: DETERMINISTIC, LOCAL,
 * CANDIDATE_ONLY, canonical false, and no model, token or external call is made.
 */

const { runContradictionRules } = require('./contradiction-rules');
const {
  MIN_OBSERVED_RECORDS, calibrate,
} = require('./cognitive-lab-probability-calibration');
const {
  PROBABILITY_KIND, fitScoreMapping, applyMapping, verifyMappingDigest,
} = require('./cognitive-lab-contradiction-calibrator');

const EVAL_SCHEMA_VERSION = 'huqan-contradiction-rule-baseline-v1';
const EVAL_STATUS = Object.freeze({ MEASURED: 'MEASURED', INSUFFICIENT: 'INSUFFICIENT' });

const SPLITS = Object.freeze(['train', 'calibration', 'holdout']);

const AUTHORITY = Object.freeze({
  kind: 'DETERMINISTIC',
  locality: 'LOCAL',
  authority: 'CANDIDATE_ONLY',
  canonical: false,
  modelCalls: 0,
  tokens: 0,
  externalCalls: 0,
});

/**
 * Run the contradiction-only detectors over one corpus record and reduce them to
 * the raw rule score and the declared confidence. A malformed record yields no
 * signal rather than a throw: the pair is still scored as "not detected".
 */
function signalsFor(record) {
  let signals;
  try {
    signals = runContradictionRules(record.stored, record.incoming);
  } catch {
    signals = [];
  }
  const list = Array.isArray(signals) ? signals : [];
  let maxSeverity = 0;
  let maxDeclaredConfidence = 0;
  for (const signal of list) {
    if (typeof signal.severity === 'number' && Number.isFinite(signal.severity)) {
      maxSeverity = Math.max(maxSeverity, signal.severity);
    }
    if (typeof signal.confidence === 'number' && Number.isFinite(signal.confidence)) {
      maxDeclaredConfidence = Math.max(maxDeclaredConfidence, signal.confidence);
    }
  }
  return Object.freeze({
    ruleIds: Object.freeze(list.map((signal) => signal.rule)),
    count: list.length,
    maxSeverity,
    maxDeclaredConfidence,
  });
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function confusionOf(rows) {
  let tp = 0; let fp = 0; let tn = 0; let fn = 0;
  for (const row of rows) {
    if (row.predicted === 1 && row.y === 1) tp += 1;
    else if (row.predicted === 1 && row.y === 0) fp += 1;
    else if (row.predicted === 0 && row.y === 0) tn += 1;
    else fn += 1;
  }
  const support = tp + fp + tn + fn;
  return Object.freeze({
    tp, fp, tn, fn,
    support,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
    coverage: ratio(tp + fp, support),
  });
}

// Reuse the Cognitive Lab calibration machinery as a forecast-quality measure.
// It is applied to a subset only when the subset clears its own sample floor,
// so a below-floor subset reports INSUFFICIENT rather than a noise Brier. It is
// only ever fed a calibrated probability (arm B); a declared heuristic
// confidence is never passed in, because it is not a forecast.
function measureProbability(rows, probabilityOf) {
  if (rows.length < MIN_OBSERVED_RECORDS) {
    return Object.freeze({ status: 'INSUFFICIENT', reason: 'sample_below_minimum', brier: null, ece: null });
  }
  const records = rows.map((row) => ({
    decisionId: row.pairId,
    status: 'observed',
    probability: probabilityOf(row),
    y: row.y,
  }));
  const result = calibrate(records);
  return Object.freeze({ status: result.status, reason: result.reason, brier: result.brier, ece: result.ece });
}

function classify(label) {
  if (label === undefined || label === null) return { status: 'MISSING', y: null };
  if (label === 'CONTRADICTION') return { status: 'SCORABLE', y: 1 };
  if (label === 'NOT_CONTRADICTION') return { status: 'SCORABLE', y: 0 };
  if (label === 'UNCERTAIN') return { status: 'UNCERTAIN', y: null };
  if (label === 'INVALID_PAIR') return { status: 'INVALID_PAIR', y: null };
  return { status: 'UNKNOWN', y: null };
}

/**
 * Evaluate the rule baseline over the frozen corpus.
 *
 * @param {object} input
 * @param {{records: ReadonlyArray<object>}} input.corpus the frozen corpus
 * @param {Record<string, {label: string}>} input.labels the frozen labels, keyed
 *   by `pairId`
 * @param {object} [input.mapping] a pre-fitted calibrator mapping; when omitted
 *   one is fitted from the calibration split
 * @param {ReadonlyArray<number>} [input.bins] calibrator bin edges
 * @returns {Readonly<object>} the arm-A/arm-B report plus detector metrics,
 *   exclusions, the fitted mapping and the authority boundary
 */
function evaluateRuleBaseline({ corpus, labels, mapping = null, bins } = {}) {
  if (!corpus || !Array.isArray(corpus.records)) throw new TypeError('corpus records are required');
  if (!labels || typeof labels !== 'object') throw new TypeError('labels are required');

  const rows = corpus.records.map((record) => {
    const labelEntry = labels[record.pairId];
    const label = labelEntry && typeof labelEntry === 'object' ? labelEntry.label : labelEntry;
    const { status, y } = classify(label);
    return {
      pairId: record.pairId,
      split: record.split,
      label: label === undefined ? null : label,
      labelStatus: status,
      y,
      signals: signalsFor(record),
    };
  });

  // Fit only on the calibration split's scorable pairs. The holdout is never
  // read here, so a mapping cannot encode holdout outcomes.
  const calibrationRows = rows.filter((row) => row.split === 'calibration' && row.labelStatus === 'SCORABLE');
  const calibrationPairIds = Object.freeze(calibrationRows.map((row) => row.pairId).sort());
  let fitted;
  if (mapping) {
    if (!verifyMappingDigest(mapping)) throw new TypeError('calibrator mapping digest does not verify');
    fitted = Object.freeze({ status: 'FITTED', mapping, digest: mapping.digest, reason: 'supplied' });
  } else {
    fitted = fitScoreMapping({
      samples: calibrationRows.map((row) => ({ score: row.signals.maxSeverity, label: row.y })),
      ...(bins ? { bins } : {}),
    });
  }
  const activeMapping = fitted.mapping;

  const scorableRows = rows.filter((row) => row.labelStatus === 'SCORABLE');
  const armRows = scorableRows.map((row) => {
    const fires = row.signals.count > 0;
    const detectorProbability = fires ? 1 : 0;
    const declaredHeuristic = fires ? row.signals.maxDeclaredConfidence : 0;
    const calibrated = fires && activeMapping
      ? applyMapping(activeMapping, row.signals.maxSeverity) : 0;
    return {
      pairId: row.pairId,
      split: row.split,
      y: row.y,
      detected: fires ? 1 : 0,
      armA: { probability: declaredHeuristic, probabilityKind: PROBABILITY_KIND.DECLARED_HEURISTIC, predicted: fires ? 1 : 0 },
      armB: { probability: calibrated, probabilityKind: PROBABILITY_KIND.CALIBRATED, predicted: fires ? 1 : 0 },
      detectorProbability,
    };
  });

  const detectorConfusion = confusionOf(armRows.map((row) => ({ y: row.y, predicted: row.detected })));
  const armAConfusion = confusionOf(armRows.map((row) => ({ y: row.y, predicted: row.armA.predicted })));
  const armBConfusion = confusionOf(armRows.map((row) => ({ y: row.y, predicted: row.armB.predicted })));

  const exclusions = Object.freeze({
    UNCERTAIN: rows.filter((row) => row.labelStatus === 'UNCERTAIN').length,
    INVALID_PAIR: rows.filter((row) => row.labelStatus === 'INVALID_PAIR').length,
    missingLabel: rows.filter((row) => row.labelStatus === 'MISSING').length,
    unknownLabel: rows.filter((row) => row.labelStatus === 'UNKNOWN').length,
  });

  const bySplit = Object.fromEntries(SPLITS.map((split) => {
    const splitRows = armRows.filter((row) => row.split === split);
    return [split, confusionOf(splitRows.map((row) => ({ y: row.y, predicted: row.detected })))];
  }));

  // Arm A states a DECLARED_HEURISTIC confidence, which is not a forecast and is
  // deliberately never scored. Arm B's calibrated probability is the only
  // forecast on this path, so it is the only one that reaches Brier/ECE.
  const armAProbability = Object.freeze({ status: 'NOT_A_FORECAST', reason: 'declared_heuristic_not_probability', brier: null, ece: null });
  const armBProbability = measureProbability(armRows, (row) => row.armB.probability);

  const status = scorableRows.length === 0 ? EVAL_STATUS.INSUFFICIENT : EVAL_STATUS.MEASURED;
  return Object.freeze({
    schemaVersion: EVAL_SCHEMA_VERSION,
    status,
    reason: status === EVAL_STATUS.MEASURED ? 'measured' : 'no_scorable_pairs',
    probabilityKind: Object.freeze({
      armA: PROBABILITY_KIND.DECLARED_HEURISTIC,
      armB: PROBABILITY_KIND.CALIBRATED,
    }),
    detector: Object.freeze({ confusion: detectorConfusion, bySplit: Object.freeze(bySplit) }),
    arms: Object.freeze({
      A: Object.freeze({ confusion: armAConfusion, probabilityKind: PROBABILITY_KIND.DECLARED_HEURISTIC, probability: armAProbability }),
      B: Object.freeze({ confusion: armBConfusion, probabilityKind: PROBABILITY_KIND.CALIBRATED, probability: armBProbability }),
    }),
    rows: Object.freeze(armRows),
    exclusions,
    calibration: Object.freeze({
      pairIds: calibrationPairIds,
      sampleCount: calibrationRows.length,
      mappingDigest: fitted.digest,
      mappingStatus: fitted.status,
    }),
    authority: AUTHORITY,
    assertsGain: false,
  });
}

module.exports = {
  EVAL_SCHEMA_VERSION,
  EVAL_STATUS,
  AUTHORITY,
  signalsFor,
  confusionOf,
  evaluateRuleBaseline,
};
