'use strict';

// #2505 implementation order (J calibration feed, first slice): prediction
// records paired with later outcomes by immutable decision ID.
//
// A prediction is a risk estimate made before the action; the outcome arrives
// later as reviewer rejection, rollback/compensation, contradiction,
// incident, confirmation, or a censored observation window. A missing outcome
// is `unknown`, never success. Comparison, tuning and any threshold change
// belong to later slices; this module only stores the pairs, in their own
// metric namespace -- action outcomes never enter the graph-hypothesis
// denominators of hypothesis-fitness/fitness-history.
//
// Durability reuses the existing mutation journal authority like the sibling
// ledgers; reopening the store resumes. Recording the same decision twice
// replays the first row instead of forking the pair.

const PAIR_OPERATION_PREFIX = 'prediction-outcome:';
const PAIR_STORE_VERSION = 'huqan-prediction-outcome-v1';
const MAX_ID_FIELD_LENGTH = 256;

const OUTCOMES = Object.freeze([
  'reviewer-rejection',
  'rollback',
  'compensation',
  'contradiction',
  'incident',
  'confirmed',
  'censored',
]);

function text(value, field, { max = MAX_ID_FIELD_LENGTH } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  if (normalized.includes('\0')) throw new TypeError(`${field} must not contain null characters`);
  return normalized;
}

function instant(value, field) {
  const normalized = text(value, field);
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis)) throw new TypeError(`${field} must be a valid instant`);
  return new Date(millis).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function requireGraph(graph) {
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    throw new TypeError('graph with runMutationOnce and prefix reads is required');
  }
  return graph;
}

function readPairRows(graph) {
  let rows = [];
  try {
    rows = graph.getCommittedMutationResultsByPrefix(PAIR_OPERATION_PREFIX);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && row.result && row.result.predictionPair === true);
}

/**
 * Record a risk prediction before the action. Re-recording the same decision
 * replays the first row: one decision, one prediction.
 */
function recordPrediction(graph, {
  decisionId, score = null, unknown = '', actionClass = null, at = null,
} = {}) {
  requireGraph(graph);
  const id = text(decisionId, 'decisionId', { max: 128 });
  let scored = null;
  let reason = '';
  if (score !== undefined && score !== null) {
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
      throw new TypeError('score must be a number between 0 and 100, or null when unknown');
    }
    scored = score;
  }
  if (scored === null) {
    reason = text(unknown, 'unknown', { max: 256 });
  } else if (unknown !== undefined && unknown !== null && String(unknown).trim() !== '') {
    throw new TypeError('unknown must be empty when scored');
  }
  const action = actionClass === undefined || actionClass === null ? null : text(actionClass, 'actionClass', { max: 64 });
  const timestamp = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const outcome = graph.runMutationOnce(
    `${PAIR_OPERATION_PREFIX}prediction:${id}`,
    () => ({
      predictionPair: true,
      storeVersion: PAIR_STORE_VERSION,
      decisionId: id,
      prediction: Object.freeze({ score: scored, unknown: reason, actionClass: action, at: timestamp }),
      outcome: null,
    }),
  );
  return Object.freeze({ replayed: Boolean(outcome.replayed), decisionId: id });
}

/**
 * Attach the later outcome to a recorded prediction. Unknown decisions and
 * second outcomes fail closed; replaying the same outcome key is idempotent.
 */
function recordOutcome(graph, { decisionId, outcome, idempotencyKey, at = null } = {}) {
  requireGraph(graph);
  const id = text(decisionId, 'decisionId', { max: 128 });
  if (!OUTCOMES.includes(outcome)) {
    throw new TypeError(`outcome must be one of ${OUTCOMES.join(', ')}`);
  }
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.trim().length > 128) {
    throw new TypeError('idempotencyKey is required');
  }
  const keyId = idempotencyKey.trim();
  const rows = readPairRows(graph);
  // Replay first: the same key returns its prior outcome without touching
  // the pair. A different key on a decided pair fails closed below.
  const opId = `${PAIR_OPERATION_PREFIX}outcome:${keyId}`;
  const prior = rows.find((row) => row.operationId === opId && row.result && row.result.outcome);
  if (prior) {
    return Object.freeze({ replayed: true, decisionId: id, outcome: prior.result.outcome.state });
  }
  const prediction = rows.find((row) => row.result
    && row.result.decisionId === id && row.result.prediction);
  if (!prediction) throw new Error(`unknown prediction: ${id}`);
  const timestamp = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const decided = rows.some((row) => row.result
    && row.result.decisionId === id && row.result.outcome);
  if (decided) throw new Error(`decision already has an outcome: ${id}`);
  const result = graph.runMutationOnce(
    `${PAIR_OPERATION_PREFIX}outcome:${keyId}`,
    () => ({
      predictionPair: true,
      storeVersion: PAIR_STORE_VERSION,
      decisionId: id,
      outcome: Object.freeze({ state: outcome, at: timestamp }),
    }),
  );
  return Object.freeze({ replayed: Boolean(result.replayed), decisionId: id, outcome });
}

/**
 * Read pairs: every recorded prediction with its outcome, or null while the
 * outcome window is still censored. Unknown stays unknown.
 */
function readPredictionPairs(graph, { decisionId = null } = {}) {
  requireGraph(graph);
  const only = decisionId === undefined || decisionId === null ? null : text(decisionId, 'decisionId', { max: 128 });
  const predictions = new Map();
  const outcomes = new Map();
  for (const row of readPairRows(graph)) {
    const result = row.result;
    if (typeof result.decisionId !== 'string') continue;
    if (only !== null && result.decisionId !== only) continue;
    if (result.prediction && !predictions.has(result.decisionId)) {
      predictions.set(result.decisionId, result.prediction);
    }
    if (result.outcome && !outcomes.has(result.decisionId)) {
      outcomes.set(result.decisionId, result.outcome);
    }
  }
  const pairs = {};
  for (const [id, prediction] of predictions) {
    pairs[id] = Object.freeze({ decisionId: id, prediction, outcome: outcomes.get(id) || null });
  }
  return Object.freeze(pairs);
}

module.exports = {
  PAIR_OPERATION_PREFIX,
  PAIR_STORE_VERSION,
  OUTCOMES,
  recordPrediction,
  recordOutcome,
  readPredictionPairs,
};
