'use strict';

/**
 * Cognitive Lab fail-closed gain evaluator (#3376, slice 3307-S3).
 *
 * Slice S1 froze the experiment manifest and slice S2 replayed it. This slice is
 * the evaluator that decides whether the replay is even allowed to produce a
 * gain number: it fails closed on leakage, source/event duplication, budget
 * mismatch, non-finite measurements, missing outcomes, forged observations and
 * authority bypass, and it keeps the nine gain dimensions apart from the
 * integrity verdict.
 *
 * The evaluator is not the replay runner. It composes `replayBaseline` -- the
 * single existing B1 workflow -- and adds the checks a gain claim needs on top:
 * a manifest whose measurement is not finite is rejected before anything is
 * scored; two examples that come from the same source event are not independent
 * samples and are rejected rather than counted twice; a caller who declares an
 * effect observed while providing no outcome is rejected instead of being
 * quietly reclassified as missing. Each guard is a separate function so a test
 * that disables one turns red.
 *
 * Two verdicts never collapse into one. `infrastructure` says whether the
 * measurement itself held (PASS/REJECT/INSUFFICIENT); `intelligenceGain` stays
 * `NOT_MEASURED` in this slice even when the baseline infrastructure PASSes,
 * because characterizing the measurement is not a demonstrated reasoning gain.
 * B1 maps to the Calibration dimension; the other eight dimensions and
 * Epistemic integrity stay NOT_MEASURED.
 *
 * Authority is unchanged. The evaluator reads a replay result and returns a
 * measurement verdict; it derives no fact, admits no candidate and promotes
 * nothing.
 *
 * Scope: a pure module plus its tests (#3376). No wiring, activation, policy,
 * receipt or release surface is touched.
 */

const { isPlainObject } = require('./is-plain-object');
const {
  MANIFEST_STATUS,
  verifyManifestDigest,
} = require('./cognitive-lab-manifest');
const {
  REPLAY_STATUS,
  REPLAY_ERROR_CODES,
  replayBaseline,
} = require('./cognitive-lab-b1-replay');

const EVALUATOR_SCHEMA_VERSION = 'huqan-cognitive-lab-evaluator-v1';

const EVALUATOR_STATUS = Object.freeze({
  EVALUATED: 'EVALUATED',
  INSUFFICIENT: 'INSUFFICIENT',
  REJECT: 'REJECT',
});

const EVALUATOR_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'evaluator_invalid_input',
  INVALID_MANIFEST: 'evaluator_invalid_manifest',
  NON_FINITE: 'evaluator_non_finite_measurement',
  DUPLICATION: 'evaluator_source_duplication',
  FORGED_OBSERVATION: 'evaluator_forged_observation',
  AUTHORITY_BYPASS: 'evaluator_authority_bypass',
  LEAKAGE: 'evaluator_leakage',
  BUDGET_MISMATCH: 'evaluator_budget_mismatch',
  MISSING_OUTCOME: 'evaluator_missing_outcome',
});

// The nine gain dimensions the task pack names. B1 measures Calibration only.
const GAIN_DIMENSIONS = Object.freeze([
  'Derivation',
  'Learning',
  'Prediction',
  'Planning',
  'Calibration',
  'Transfer',
  'Autonomy',
  'Efficiency',
  'EpistemicIntegrity',
]);

const MEASURED_DIMENSION_BY_BENCHMARK = Object.freeze({ B1: 'Calibration' });

const V0_1_CALIBRATION = Object.freeze({
  brier: 'NOT_MEASURED',
  ece: 'NOT_MEASURED',
  reason: 'NO_PRE_OUTCOME_PROBABILITY',
});

const B1_KNOWN_LIMITATIONS = Object.freeze([
  Object.freeze({ code: 'duplicate_source_independence', status: 'KNOWN_LIMITATION', trackedBy: '#3309' }),
  Object.freeze({ code: 'support_invalidation', status: 'KNOWN_LIMITATION', trackedBy: '#3309' }),
]);

class CognitiveLabEvaluatorError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'CognitiveLabEvaluatorError';
    this.code = code;
    this.path = path;
  }
}

// `measured: false` is the refusal path: the benchmark may be known, but a
// refused evaluation observed nothing, so every dimension stays NOT_MEASURED.
function gainReport(benchmark, measured = true) {
  const report = {};
  const measuredDimension = measured ? MEASURED_DIMENSION_BY_BENCHMARK[benchmark] || null : null;
  for (const dimension of GAIN_DIMENSIONS) {
    report[dimension] = dimension === measuredDimension ? 'MEASURED' : 'NOT_MEASURED';
  }
  return Object.freeze(report);
}

function integrityOf(status, code, detail) {
  return Object.freeze({ status, code: code || null, detail: detail || null });
}

/**
 * A rejected or insufficient evaluation. It carries no digest and no belief:
 * there is nothing to compare across replays when the measurement did not hold.
 */
function refuse(status, code, path, message, integrity, carry = null) {
  const evidence = isPlainObject(carry) ? carry : {};
  const benchmark = evidence.benchmark || null;
  return Object.freeze({
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    status,
    benchmark,
    correctnessDigest: null,
    counts: evidence.counts || null,
    belief: evidence.belief || null,
    mechanisms: evidence.mechanisms || null,
    gain: gainReport(benchmark, false),
    calibration: V0_1_CALIBRATION,
    knownLimitations: B1_KNOWN_LIMITATIONS,
    intelligenceGain: 'NOT_MEASURED',
    infrastructure: Object.freeze({ status: status === EVALUATOR_STATUS.REJECT ? 'REJECT' : 'INSUFFICIENT' }),
    integrity,
    error: Object.freeze({ code, path, message }),
  });
}

/**
 * A measurement that was allowed to produce a number. `infrastructure` reports
 * the measurement verdict; `intelligenceGain` deliberately stays NOT_MEASURED.
 */
function accept(benchmark, correctnessDigest, counts, belief, mechanisms) {
  return Object.freeze({
    schemaVersion: EVALUATOR_SCHEMA_VERSION,
    status: EVALUATOR_STATUS.EVALUATED,
    benchmark,
    correctnessDigest,
    counts,
    belief,
    mechanisms,
    gain: gainReport(benchmark),
    calibration: V0_1_CALIBRATION,
    knownLimitations: B1_KNOWN_LIMITATIONS,
    intelligenceGain: 'NOT_MEASURED',
    infrastructure: Object.freeze({ status: 'PASS' }),
    integrity: integrityOf('PASS', null, null),
    error: null,
  });
}

function assertFinite(value, path) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new CognitiveLabEvaluatorError(EVALUATOR_ERROR_CODES.NON_FINITE, path, 'a measurement cannot be NaN or Infinity');
  }
}

/**
 * A measurement budget that is not finite cannot be compared, so it is rejected
 * before any number is derived from it. Both the frozen manifest budget and the
 * experiment budget are checked; a string counter (`unknown`) is not a number
 * and is left to the manifest contract.
 */
function assertFiniteMeasurements(manifest, experiment) {
  for (const source of [{ value: manifest && manifest.budget, prefix: 'manifest.budget' }, { value: experiment && experiment.budget, prefix: 'experiment.budget' }]) {
    if (!isPlainObject(source.value)) continue;
    for (const [key, value] of Object.entries(source.value)) assertFinite(value, `${source.prefix}.${key}`);
  }
}

/**
 * Two examples derived from the same source event are correlated, not
 * independent samples. Counting them twice would inflate the denominator, so a
 * source event that names more than one decision is rejected. A split that
 * lists the same id twice is the same defect one level up.
 */
function assertNoSourceDuplication(experiment) {
  if (!isPlainObject(experiment)) return;
  const sourceEvents = experiment.sourceEvents;
  if (isPlainObject(sourceEvents)) {
    for (const [eventId, decisionIds] of Object.entries(sourceEvents)) {
      if (Array.isArray(decisionIds) && decisionIds.length > 1) {
        throw new CognitiveLabEvaluatorError(
          EVALUATOR_ERROR_CODES.DUPLICATION,
          `experiment.sourceEvents.${eventId}`,
          'a source event maps to more than one decision; correlated examples are not independent samples',
        );
      }
    }
  }
  const split = experiment.split;
  if (!isPlainObject(split)) return;
  for (const name of ['train', 'holdout', 'transfer']) {
    const ids = split[name];
    if (!Array.isArray(ids)) continue;
    if (new Set(ids.map(String)).size !== ids.length) {
      throw new CognitiveLabEvaluatorError(
        EVALUATOR_ERROR_CODES.DUPLICATION,
        `experiment.split.${name}`,
        'a split lists the same id more than once',
      );
    }
  }
}

/**
 * Declaring an effect observed while providing no outcome is a forged
 * observation: the caller asserts a verified sample that does not exist. It is
 * rejected rather than reclassified as missing, because the declared evidence
 * and the persisted evidence disagree.
 */
function assertNoForgedObservation(experiment) {
  if (!isPlainObject(experiment) || !isPlainObject(experiment.observations)) return;
  const outcomes = isPlainObject(experiment.outcomes) ? experiment.outcomes : {};
  for (const [decisionId, kind] of Object.entries(experiment.observations)) {
    if (kind !== 'observed') continue;
    const outcome = outcomes[decisionId];
    if (outcome === undefined || outcome === 'missing') {
      throw new CognitiveLabEvaluatorError(
        EVALUATOR_ERROR_CODES.FORGED_OBSERVATION,
        `experiment.observations.${decisionId}`,
        'an observation declared observed has no outcome to verify it',
      );
    }
  }
}

function rejectFromReplay(result) {
  const error = result.error || {};
  const carry = { benchmark: result.benchmark, counts: result.counts, belief: result.belief, mechanisms: result.mechanisms };
  if (result.integrity && result.integrity.status === 'REJECT') {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.AUTHORITY_BYPASS, error.path || 'replay', 'calibration counted a prediction from outside the frozen split', result.integrity, carry);
  }
  if (error.code === REPLAY_ERROR_CODES.OVERLAP) {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.LEAKAGE, error.path || 'replay', 'a split leaks an id across partitions', integrityOf('REJECT', EVALUATOR_ERROR_CODES.LEAKAGE, 'holdout/transfer id appears in another partition'), carry);
  }
  if (error.code === REPLAY_ERROR_CODES.BUDGET_MISMATCH) {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.BUDGET_MISMATCH, error.path || 'replay', 'the experiment budget disagrees with the frozen manifest', integrityOf('REJECT', EVALUATOR_ERROR_CODES.BUDGET_MISMATCH, 'budget mismatch'), carry);
  }
  if (error.code === REPLAY_ERROR_CODES.FORGED_OBSERVATION) {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.FORGED_OBSERVATION, error.path || 'replay', 'a counted sample has no persisted prediction/outcome row', integrityOf('REJECT', EVALUATOR_ERROR_CODES.FORGED_OBSERVATION, 'forged observation'), carry);
  }
  if (error.code === REPLAY_ERROR_CODES.INSUFFICIENT_DATA) {
    return refuse(EVALUATOR_STATUS.INSUFFICIENT, EVALUATOR_ERROR_CODES.MISSING_OUTCOME, error.path || 'replay', 'no observed sample reached calibration authority', integrityOf('INSUFFICIENT', EVALUATOR_ERROR_CODES.MISSING_OUTCOME, 'missing outcomes cannot be successes'), carry);
  }
  return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.INVALID_INPUT, error.path || 'replay', error.message || 'the replay was rejected', integrityOf('REJECT', EVALUATOR_ERROR_CODES.INVALID_INPUT, 'invalid replay'), carry);
}

/**
 * Evaluate a frozen B1 baseline and return a fail-closed gain verdict.
 *
 * @param {object} graph a graph store exposing the prediction-outcome surface
 * @param {object} input `{ manifest, manifestDigest, experiment }`
 * @param {{mode?: string, ruleId?: string, declaredConfidence?: number}} opts
 * @returns {Readonly<object>} REJECT when a negative/mutation guard fires or the
 *   replay is rejected, INSUFFICIENT when no observed sample exists, EVALUATED
 *   otherwise. `gain.Calibration` is MEASURED for B1; `intelligenceGain` is
 *   always NOT_MEASURED in this slice.
 */
function evaluateGain(graph, input = {}, opts = {}) {
  if (!isPlainObject(input)) {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.INVALID_INPUT, 'input', 'input must be an object', integrityOf('REJECT', EVALUATOR_ERROR_CODES.INVALID_INPUT, 'invalid input'));
  }
  if (!isPlainObject(input.manifest) || typeof input.manifestDigest !== 'string' || input.manifestDigest === '') {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.INVALID_INPUT, 'manifest', 'a manifest object and its expected digest are required', integrityOf('REJECT', EVALUATOR_ERROR_CODES.INVALID_INPUT, 'invalid input'));
  }

  try {
    assertFiniteMeasurements(input.manifest, input.experiment);
    const manifestVerdict = verifyManifestDigest(input.manifest, input.manifestDigest);
    if (manifestVerdict.status !== MANIFEST_STATUS.VALID) {
      const first = manifestVerdict.errors && manifestVerdict.errors[0];
      if (manifestVerdict.status === MANIFEST_STATUS.INSUFFICIENT) {
        return refuse(EVALUATOR_STATUS.INSUFFICIENT, EVALUATOR_ERROR_CODES.MISSING_OUTCOME, first && first.path ? first.path : 'manifest', first && first.message ? first.message : 'manifest data is insufficient', integrityOf('INSUFFICIENT', EVALUATOR_ERROR_CODES.MISSING_OUTCOME, 'manifest data is insufficient'));
      }
      return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.INVALID_MANIFEST, first && first.path ? first.path : 'manifest', first && first.message ? first.message : 'manifest is invalid', integrityOf('REJECT', EVALUATOR_ERROR_CODES.INVALID_MANIFEST, 'invalid manifest'));
    }
    assertNoSourceDuplication(input.experiment);
    assertNoForgedObservation(input.experiment);
  } catch (error) {
    if (error instanceof CognitiveLabEvaluatorError) {
      return refuse(EVALUATOR_STATUS.REJECT, error.code, error.path, error.message, integrityOf('REJECT', error.code, error.message));
    }
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.INVALID_INPUT, 'input', error && error.message ? error.message : 'invalid input', integrityOf('REJECT', EVALUATOR_ERROR_CODES.INVALID_INPUT, 'invalid input'));
  }

  const replay = replayBaseline(graph, input, opts);
  if (replay.status === REPLAY_STATUS.REJECT) return rejectFromReplay(replay);
  if (replay.status !== REPLAY_STATUS.REPLAYED) return rejectFromReplay(replay);

  // The evaluator re-derives the reconciliation rather than trusting the
  // replay's own status: a belief that counted more samples than the observed
  // bucket holds is a forged observation, and a digest with no observed sample
  // is a silent success.
  const { counts, belief } = replay;
  if (!counts || !belief) {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.INVALID_INPUT, 'replay', 'the replay produced no counts or belief', integrityOf('REJECT', EVALUATOR_ERROR_CODES.INVALID_INPUT, 'invalid replay'));
  }
  if (counts.observed + counts.censored + counts.missing + counts.reported + counts.uncounted !== counts.ingested) {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.FORGED_OBSERVATION, 'counts', 'outcome buckets do not account for every ingested example', integrityOf('REJECT', EVALUATOR_ERROR_CODES.FORGED_OBSERVATION, 'unreconciled outcome buckets'));
  }
  if (belief.observedSamples !== counts.observed) {
    return refuse(EVALUATOR_STATUS.REJECT, EVALUATOR_ERROR_CODES.FORGED_OBSERVATION, 'belief.observedSamples', 'calibration counted more samples than the observed bucket holds', integrityOf('REJECT', EVALUATOR_ERROR_CODES.FORGED_OBSERVATION, 'forged observation'));
  }
  if (counts.observed === 0) {
    return refuse(EVALUATOR_STATUS.INSUFFICIENT, EVALUATOR_ERROR_CODES.MISSING_OUTCOME, 'counts.observed', 'no observed sample reached calibration authority', integrityOf('INSUFFICIENT', EVALUATOR_ERROR_CODES.MISSING_OUTCOME, 'missing outcomes cannot be successes'), replay.benchmark);
  }

  return accept(replay.benchmark, replay.correctnessDigest, counts, belief, replay.mechanisms);
}

module.exports = {
  EVALUATOR_SCHEMA_VERSION,
  EVALUATOR_STATUS,
  EVALUATOR_ERROR_CODES,
  GAIN_DIMENSIONS,
  MEASURED_DIMENSION_BY_BENCHMARK,
  V0_1_CALIBRATION,
  B1_KNOWN_LIMITATIONS,
  CognitiveLabEvaluatorError,
  evaluateGain,
};
