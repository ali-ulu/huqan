'use strict';

/**
 * Cognitive Lab decision-probability calibration (#3308, slice 3308-P1).
 *
 * #3308's problem is precise: the product already produces aggregate agreement
 * suggestions for an actor/sourceType (`lib/trust-calibration.js`), but it does
 * not measure a probability stated for a *single* decision against what
 * actually happened. Inference predictions deliberately record
 * `rule_belief_not_outcome_probability`; verify confidence is verdict
 * certainty. None of those are an outcome probability, and this slice does not
 * convert them -- SystemConfidence, cosine, entropy, ordinal risk and a rule
 * posterior are never turned into a `p`.
 *
 * A probability enters only when a caller states one *explicitly, before the
 * outcome is observed*, and freezes it. The store is the existing
 * prediction/outcome ledger (`lib/prediction-outcome-pairs.js`): a probability
 * is a `decision-probability:<measurementId>:<decisionId>` mutation in its own
 * namespace, joined to the base prediction by `decisionId`. Recording after an
 * outcome exists is rejected -- a probability you can move after seeing the
 * result is not a forecast.
 *
 * `calibrate` is a pure function over the read-back records. It keeps attempt /
 * eligible / observed / censored / missing / measurement_error distinct, so a
 * missing outcome is never scored as success; it computes Brier, reliability
 * bins and ECE only over valid observed pairs; and it is fail-closed: no data
 * is INSUFFICIENT, never a number. Bin edges, the sample-adequacy minimum and
 * the metric direction are inputs frozen before the experiment runs, and the
 * direction is stated so a locked comparison cannot be reinterpreted after the
 * fact.
 *
 * Scope: a pure module plus its tests (#3308-P1). No wiring, activation,
 * policy, receipt or release surface is touched; a paired baseline/candidate
 * delta and the non-inferiority tolerance belong to the next slice.
 */

const { readPredictionPairs } = require('./prediction-outcome-pairs');

const PROBABILITY_SCHEMA_VERSION = 'huqan-cognitive-lab-probability-v1';
const PROBABILITY_OPERATION_PREFIX = 'decision-probability:';
const MAX_ID_FIELD_LENGTH = 256;

// The canonical eleven-bin reliability diagram (Guo et al., 2017), stated once
// so a caller can freeze it in the manifest instead of inventing edges at
// scoring time.
const ELEVEN_BINS = Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);

// Sample adequacy is a pre-declared threshold: below it a Brier score is noise,
// not a measurement. Ten is the floor the slice locks; the manifest owns any
// larger value.
const MIN_OBSERVED_RECORDS = 10;

const ADVERSE_STATES = Object.freeze([
  'reviewer-rejection', 'rollback', 'compensation', 'contradiction', 'incident',
]);

const RECORD_STATUS = Object.freeze({
  OBSERVED: 'observed',
  MISSING: 'missing',
  CENSORED: 'censored',
  MEASUREMENT_ERROR: 'measurement_error',
});

const CALIBRATION_STATUS = Object.freeze({
  MEASURED: 'MEASURED',
  INSUFFICIENT: 'INSUFFICIENT',
});

// Locked before the experiment: a lower Brier is better, so a certainty claim
// that overstates p is penalized. The number is never re-chosen after scoring.
const METRIC_DIRECTION = 'certainty_overconfidence';

function text(value, field, max = MAX_ID_FIELD_LENGTH) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  if (normalized.includes('\0')) throw new TypeError(`${field} must not contain null characters`);
  return normalized;
}

function instant(value, field) {
  const millis = Date.parse(text(value, field));
  if (!Number.isFinite(millis)) throw new TypeError(`${field} must be a valid instant`);
  return new Date(millis).toISOString();
}

function requireGraph(graph) {
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new TypeError('graph with runMutationOnce and prefix reads is required');
  }
  return graph;
}

// measurementId and decisionId are caller-supplied and may themselves contain
// ':', so a plain `${mid}:${id}` join is ambiguous: (a:b, c) and (a, b:c) would
// collapse to one operation identity and replay the wrong probability. Encode
// each bounded id as a JSON string so the join is injective.
function probabilityOperationId(measurementId, decisionId) {
  return `${PROBABILITY_OPERATION_PREFIX}${JSON.stringify(measurementId)}:${JSON.stringify(decisionId)}`;
}

function requireProbability(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be a number between 0 and 1`);
  }
  return value;
}

function readProbabilityRows(graph) {
  // A read failure is not an empty store: swallowing it would let a retry miss
  // its prior row and re-record a probability, and would make calibrate report
  // existing measurements as absent. Only a successful non-array read is empty.
  const rows = graph.getCommittedMutationResultsByPrefix(PROBABILITY_OPERATION_PREFIX);
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && row.result && row.result.decisionProbability === true);
}

/**
 * Record an explicit decision probability before its outcome is observed.
 * Re-recording the same measurement/decision replays the first row, so one
 * decision carries one frozen probability. A probability on a decision that
 * already has an outcome fails closed.
 */
function recordDecisionProbability(graph, {
  measurementId, decisionId, probability, at = null,
} = {}) {
  requireGraph(graph);
  const mid = text(measurementId, 'measurementId', 128);
  const id = text(decisionId, 'decisionId', 128);
  const p = requireProbability(probability, 'probability');
  const timestamp = at === undefined || at === null ? new Date().toISOString() : instant(at, 'at');
  // Idempotence first: the same measurement/decision returns its frozen row.
  // Only a *new* probability after the outcome is observed is refused, so a
  // forecast cannot be rewritten once the result is known.
  const opId = probabilityOperationId(mid, id);
  const prior = readProbabilityRows(graph).find((row) => row.operationId === opId
    && row.result && row.result.probability
    && row.result.measurementId === mid && row.result.decisionId === id);
  if (prior) {
    return Object.freeze({ replayed: true, measurementId: mid, decisionId: id, probability: prior.result.probability.value });
  }
  const pair = readPredictionPairs(graph, { decisionId: id })[id];
  if (pair && pair.outcome) throw new Error(`decision already has an outcome: ${id}`);
  const result = graph.runMutationOnce(
    opId,
    () => ({
      decisionProbability: true,
      schemaVersion: PROBABILITY_SCHEMA_VERSION,
      measurementId: mid,
      decisionId: id,
      probability: Object.freeze({ value: p, at: timestamp }),
    }),
  );
  return Object.freeze({ replayed: Boolean(result.replayed), measurementId: mid, decisionId: id, probability: p });
}

/**
 * Read explicit probabilities back and classify each against its outcome.
 * `measurementId` scopes one experiment's source/frame/split identity; records
 * from other measurements are left out. A prediction with no outcome is
 * `censored` (the window is still open), never success; a decision carrying a
 * probability but no base prediction is `missing`; an outcome state outside the
 * known vocabulary is a `measurement_error` rather than a silent 0 or 1.
 */
function readCalibratedRecords(graph, { measurementId = null } = {}) {
  requireGraph(graph);
  const only = measurementId === undefined || measurementId === null
    ? null : text(measurementId, 'measurementId', 128);
  const pairs = readPredictionPairs(graph);
  const latest = new Map();
  for (const row of readProbabilityRows(graph)) {
    const result = row.result;
    if (typeof result.decisionId !== 'string' || !result.probability) continue;
    if (only !== null && result.measurementId !== only) continue;
    const key = `${result.measurementId}\u0000${result.decisionId}`;
    latest.set(key, result);
  }
  const keys = [...latest.keys()].sort();
  const records = keys.map((key) => {
    const result = latest.get(key);
    const { decisionId, measurementId: mid } = result;
    const probability = result.probability.value;
    const base = Object.freeze({ decisionId, measurementId: mid, probability });
    const pair = pairs[decisionId];
    if (!pair || !pair.prediction) {
      return Object.freeze({ ...base, status: RECORD_STATUS.MISSING, outcome: null, y: null });
    }
    if (!pair.outcome) {
      return Object.freeze({ ...base, status: RECORD_STATUS.CENSORED, outcome: null, y: null });
    }
    const state = pair.outcome.state;
    if (state === 'censored') {
      return Object.freeze({ ...base, status: RECORD_STATUS.CENSORED, outcome: state, y: null });
    }
    if (state === 'confirmed') {
      return Object.freeze({ ...base, status: RECORD_STATUS.OBSERVED, outcome: state, y: 1 });
    }
    if (ADVERSE_STATES.includes(state)) {
      return Object.freeze({ ...base, status: RECORD_STATUS.OBSERVED, outcome: state, y: 0 });
    }
    return Object.freeze({ ...base, status: RECORD_STATUS.MEASUREMENT_ERROR, outcome: state, y: null });
  });
  return Object.freeze(records);
}

function isScorable(record) {
  return (record.y === 0 || record.y === 1)
    && typeof record.probability === 'number' && Number.isFinite(record.probability)
    && record.probability >= 0 && record.probability <= 1;
}

function validateBins(bins) {
  if (!Array.isArray(bins) || bins.length < 1) {
    throw new TypeError('bins must be at least one strictly increasing edge in (0, 1]');
  }
  let previous = 0;
  for (const edge of bins) {
    if (typeof edge !== 'number' || !Number.isFinite(edge) || edge <= 0 || edge > 1) {
      throw new TypeError('each bin edge must be a number in (0, 1]');
    }
    if (edge <= previous) throw new TypeError('bin edges must be strictly increasing');
    previous = edge;
  }
  if (bins[bins.length - 1] !== 1) {
    throw new TypeError('the final bin edge must be 1 so every probability falls in a bin');
  }
  return Object.freeze([...bins]);
}

function insufficient(measurement, reason) {
  return Object.freeze({
    schemaVersion: PROBABILITY_SCHEMA_VERSION,
    status: CALIBRATION_STATUS.INSUFFICIENT,
    direction: METRIC_DIRECTION,
    measurement,
    brier: null,
    bins: null,
    ece: null,
    reliable: false,
    assertsGain: false,
    reason,
  });
}

/**
 * Pure calibration over classified records. Brier is the mean squared error of
 * the stated p against the 0/1 outcome; reliability bins report the mean
 * forecast and the observed rate per bin; ECE is the sample-weighted mean gap
 * between them. Dropping a bin edge makes a wrong high p improve ECE while
 * worsening Brier, so the two are reported together. `assertsGain` stays false:
 * a gain claim needs a paired baseline/candidate delta, which is the next
 * slice, not this one.
 */
function calibrate(records, { bins = ELEVEN_BINS, minObserved = MIN_OBSERVED_RECORDS } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const edges = validateBins(bins);
  // The floor is the slice's locked minimum, not 1: a caller may freeze a
  // larger threshold but must not lower it below MIN_OBSERVED_RECORDS.
  if (!Number.isInteger(minObserved) || minObserved < MIN_OBSERVED_RECORDS) {
    throw new TypeError(`minObserved must be an integer of at least ${MIN_OBSERVED_RECORDS}`);
  }
  const measurement = {
    attempt: 0, eligible: 0, observed: 0, censored: 0, missing: 0, measurement_error: 0, duplicate: 0,
  };
  const scored = [];
  const seenDecisions = new Set();
  for (const record of records) {
    // One decision is one event: a second record for it (another measurement,
    // or the same record repeated) must not count as an independent sample.
    if (seenDecisions.has(record.decisionId)) {
      measurement.duplicate += 1;
      continue;
    }
    seenDecisions.add(record.decisionId);
    measurement.attempt += 1;
    if (record.status === RECORD_STATUS.OBSERVED && !isScorable(record)) {
      // An 'observed' record whose outcome or probability cannot be scored is a
      // measurement error, never a silent 0 or NaN.
      measurement.eligible += 1;
      measurement.measurement_error += 1;
    } else if (record.status === RECORD_STATUS.OBSERVED) {
      measurement.eligible += 1;
      measurement.observed += 1;
      scored.push(record);
    } else if (record.status === RECORD_STATUS.CENSORED) {
      measurement.eligible += 1;
      measurement.censored += 1;
    } else if (record.status === RECORD_STATUS.MISSING) {
      measurement.missing += 1;
    } else {
      measurement.eligible += 1;
      measurement.measurement_error += 1;
    }
  }
  const frozen = Object.freeze(measurement);
  if (scored.length === 0) {
    return insufficient(frozen, frozen.eligible === 0 ? 'no_data' : 'no_observed_outcomes');
  }
  let sum = 0;
  for (const record of scored) sum += (record.probability - record.y) ** 2;
  const brier = sum / scored.length;

  const counts = edges.map(() => 0);
  const probSum = edges.map(() => 0);
  const ySum = edges.map(() => 0);
  for (const record of scored) {
    let index = edges.findIndex((edge) => record.probability < edge);
    if (index === -1) index = edges.length - 1;
    counts[index] += 1;
    probSum[index] += record.probability;
    ySum[index] += record.y;
  }
  const reliability = edges.map((upper, index) => Object.freeze({
    lower: index === 0 ? 0 : edges[index - 1],
    upper,
    count: counts[index],
    meanProbability: counts[index] === 0 ? null : probSum[index] / counts[index],
    observedRate: counts[index] === 0 ? null : ySum[index] / counts[index],
  }));
  let ece = 0;
  for (let index = 0; index < edges.length; index += 1) {
    if (counts[index] === 0) continue;
    ece += (counts[index] / scored.length)
      * Math.abs(probSum[index] / counts[index] - ySum[index] / counts[index]);
  }
  const reliable = scored.length >= minObserved;
  return Object.freeze({
    schemaVersion: PROBABILITY_SCHEMA_VERSION,
    status: reliable ? CALIBRATION_STATUS.MEASURED : CALIBRATION_STATUS.INSUFFICIENT,
    direction: METRIC_DIRECTION,
    measurement: frozen,
    brier,
    bins: Object.freeze(reliability),
    ece,
    reliable,
    assertsGain: false,
    reason: reliable ? 'measured' : 'sample_below_minimum',
  });
}

module.exports = {
  PROBABILITY_SCHEMA_VERSION,
  PROBABILITY_OPERATION_PREFIX,
  ELEVEN_BINS,
  MIN_OBSERVED_RECORDS,
  ADVERSE_STATES,
  RECORD_STATUS,
  CALIBRATION_STATUS,
  METRIC_DIRECTION,
  recordDecisionProbability,
  readCalibratedRecords,
  calibrate,
};
