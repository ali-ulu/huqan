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

const { RISK_LEVEL_BANDS } = require('./risk-scale');
const { isPlainObject } = require('./is-plain-object');
const { isDeepStrictEqual } = require('node:util');
const { stableStringify, sha256Hex } = require('./hash-chain');
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

function scopedBinding(binding) {
  if (binding === undefined) return {};
  const fields = ['workspaceId', 'runId', 'stepId', 'frameHash', 'expectationHash', 'sourceGroup', 'sourceRefs'];
  if (!isPlainObject(binding) || Object.keys(binding).some(key => ![...fields, 'perceptKey'].includes(key))) throw new TypeError('invalid prediction binding');
  const result = {};
  for (const key of fields.filter(key => key !== 'sourceRefs')) result[key] = text(binding[key], key);
  if (!Array.isArray(binding.sourceRefs) || binding.sourceRefs.length === 0 || binding.sourceRefs.length > 8) throw new TypeError('invalid sourceRefs');
  result.sourceRefs = [...new Set(binding.sourceRefs.map(ref => text(ref, 'sourceRef')))];
  if (binding.perceptKey !== undefined) result.perceptKey = text(binding.perceptKey, 'perceptKey');
  return result;
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

function bindingFrom(source) {
  return source.workspaceId === undefined ? {} : scopedBinding(Object.fromEntries(
    ['workspaceId', 'runId', 'stepId', 'frameHash', 'expectationHash', 'sourceGroup', 'sourceRefs', 'perceptKey']
      .filter(key => source[key] !== undefined).map(key => [key, source[key]])));
}

function predictionBindingHash({ decisionId, prediction, binding, rewardContext }) {
  return sha256Hex(stableStringify({ decisionId, prediction, binding, rewardContext }));
}

function exactObject(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function frozenRewardContext(value, binding, id, actionClass, at) {
  if (value === undefined) return undefined;
  if (!exactObject(value, ['key', 'expected', 'history']) || typeof actionClass !== 'string' || !actionClass
    || value.key !== `risk:${actionClass}`
    || !(value.expected === null || (Number.isFinite(value.expected) && Math.abs(value.expected) <= 1))
    || !binding.workspaceId || !exactObject(value.history, ['workspaceId', 'frameHash', 'historyBoundary'])
    || value.history.workspaceId !== binding.workspaceId || value.history.frameHash !== binding.frameHash)
    throw new TypeError('invalid reward context binding');
  const boundary = value.history.historyBoundary;
  if (!exactObject(boundary, ['at', 'decisionId', 'priorDecisionIds']) || boundary.decisionId !== id
    || !Array.isArray(boundary.priorDecisionIds)) throw new TypeError('invalid reward history boundary');
  const timestamp = instant(boundary.at, 'reward history at');
  const ids = boundary.priorDecisionIds.map(prior => text(prior, 'prior decisionId', { max: 128 }));
  if (Date.parse(timestamp) > Date.parse(at) || Date.parse(at) > new Date().getTime()
    || ids.includes(id) || new Set(ids).size !== ids.length) throw new TypeError('invalid reward history boundary');
  return Object.freeze({ key: value.key, expected: value.expected,
    history: Object.freeze({ workspaceId: binding.workspaceId, frameHash: binding.frameHash,
      historyBoundary: Object.freeze({ at: timestamp, decisionId: id, priorDecisionIds: Object.freeze(ids) }) }) });
}

function acceptedSource(value, binding) {
  if (value === undefined) return undefined;
  if (!exactObject(value, ['sourceRef', 'sourceHash', 'scopeHash', 'runId'])
    || typeof value.sourceHash !== 'string' || typeof value.scopeHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sourceHash) || !/^[a-f0-9]{64}$/.test(value.scopeHash)
    || value.scopeHash !== binding.expectationHash || !binding.sourceRefs?.includes(value.sourceRef)
    || value.runId !== text(value.runId, 'native runId') || value.sourceRef !== `coder-run:${value.runId}`)
    throw new TypeError('invalid acceptance binding');
  return Object.freeze({ sourceRef: value.sourceRef, sourceHash: value.sourceHash,
    scopeHash: value.scopeHash, runId: value.runId });
}

/**
 * Record a risk prediction before the action. Re-recording the same decision
 * replays the first row: one decision, one prediction.
 */
function recordPrediction(graph, {
  decisionId, score = null, unknown = '', actionClass = null, at = null, binding, rewardContext,
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
  const scoped = scopedBinding(binding);
  const frozenContext = frozenRewardContext(rewardContext, scoped, id, action, timestamp);
  const prior = binding === undefined ? null : readPairRows(graph).find(row => row.result.decisionId === id && row.result.prediction);
  if (prior && JSON.stringify(scopedBinding(Object.fromEntries(Object.keys(scoped).map(key => [key, prior.result[key]])))) !== JSON.stringify(scoped)) throw new Error('prediction binding conflict');
  if (prior && !isDeepStrictEqual(prior.result.rewardContext, frozenContext)) throw new Error('reward context conflict');
  const outcome = graph.runMutationOnce(
    `${PAIR_OPERATION_PREFIX}prediction:${id}`,
    () => ({
      predictionPair: true,
      ...scoped,
      storeVersion: PAIR_STORE_VERSION,
      decisionId: id,
      ...(frozenContext === undefined ? {} : { rewardContext: frozenContext }),
      prediction: Object.freeze({ score: scored, unknown: reason, actionClass: action, at: timestamp }),
      outcome: null,
    }),
  );
  const stored = outcome.result;
  return Object.freeze({ replayed: Boolean(outcome.replayed), decisionId: id,
    ...(stored?.rewardContext === undefined ? {} : { predictionHash: predictionBindingHash({
      decisionId: id, prediction: stored.prediction, binding: bindingFrom(stored), rewardContext: stored.rewardContext,
    }) }) });
}

/**
 * Attach the later outcome to a recorded prediction. Unknown decisions and
 * second outcomes fail closed; replaying the same outcome key is idempotent.
 */
function recordOutcome(graph, { decisionId, outcome, idempotencyKey, at = null, acceptance } = {}) {
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
    if (prior.result.workspaceId !== undefined && prior.result.decisionId !== id) throw new Error('outcome binding conflict');
    if ((acceptance !== undefined || prior.result.acceptance !== undefined)
      && (!isDeepStrictEqual(prior.result.acceptance, acceptedSource(acceptance, prior.result))
        || prior.result.outcome.state !== outcome)) throw new Error('acceptance binding conflict');
    return Object.freeze({ replayed: true, decisionId: id, outcome: prior.result.outcome.state });
  }
  const prediction = rows.find((row) => row.result
    && row.result.decisionId === id && row.result.prediction);
  if (!prediction) throw new Error(`unknown prediction: ${id}`);
  const timestamp = at === undefined || at === null ? nowIso() : instant(at, 'at');
  const source = prediction.result;
  const scoped = bindingFrom(source);
  const accepted = acceptedSource(acceptance, scoped);
  if (accepted && Date.parse(timestamp) > new Date().getTime()) throw new TypeError('acceptance is in the future');
  if (source.workspaceId !== undefined && Date.parse(timestamp) < Date.parse(source.prediction.at)) throw new Error('outcome precedes prediction');
  const decided = rows.some((row) => row.result
    && row.result.decisionId === id && row.result.outcome);
  if (decided) throw new Error(`decision already has an outcome: ${id}`);
  const result = graph.runMutationOnce(
    `${PAIR_OPERATION_PREFIX}outcome:${keyId}`,
    () => ({
      predictionPair: true,
      ...scoped,
      storeVersion: PAIR_STORE_VERSION,
      decisionId: id,
      ...(accepted === undefined ? {} : { acceptance: accepted }),
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
      predictions.set(result.decisionId, result);
    }
    if (result.outcome && !outcomes.has(result.decisionId)) {
      outcomes.set(result.decisionId, result);
    }
  }
  const pairs = {};
  for (const [id, source] of predictions) {
    const decided = outcomes.get(id), prediction = source.prediction;
    const metadata = source.rewardContext !== undefined || decided?.acceptance !== undefined;
    const binding = metadata ? bindingFrom(source) : null;
    if (metadata && decided && (!isDeepStrictEqual(bindingFrom(decided), binding)
      || Date.parse(instant(decided.outcome.at, 'outcome at')) < Date.parse(prediction.at)
      || Date.parse(decided.outcome.at) > new Date().getTime())) throw new TypeError('invalid persisted outcome binding');
    const rewardContext = metadata ? frozenRewardContext(source.rewardContext, binding, id, prediction.actionClass, prediction.at) : undefined;
    const acceptance = metadata ? acceptedSource(decided?.acceptance, binding) : undefined;
    pairs[id] = Object.freeze({ decisionId: id, prediction, outcome: decided?.outcome || null,
      ...(metadata ? { binding: Object.freeze({ ...binding, sourceRefs: Object.freeze([...binding.sourceRefs]) }) } : {}),
      ...(rewardContext === undefined ? {} : { rewardContext,
        predictionHash: predictionBindingHash({ decisionId: id, prediction, binding, rewardContext }) }),
      ...(acceptance === undefined ? {} : { acceptance }) });
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
  comparePredictionOutcome,
  predictionBindingHash,
};

/**
 * #2505 J: compare one recorded prediction with its outcome. Pure decision
 * support for calibration: `agrees` is true when a high estimate met an
 * adverse outcome or a low estimate met confirmation, false for misses and
 * false alarms, and null whenever either side is unknown (unscored
 * prediction, missing or censored outcome). The high/low cut is the
 * canonical HIGH band floor, derived -- never copied -- so it cannot drift
 * from the scale every gate already uses. No tuning, no thresholds changed.
 */
function comparePredictionOutcome({ score = null, outcome = null } = {}) {
  const highFloor = (() => {
    const band = RISK_LEVEL_BANDS.find(([, level]) => level === 'HIGH');
    return band ? band[0] : 50;
  })();
  const scored = typeof score === 'number' && Number.isFinite(score);
  const adverse = outcome === 'reviewer-rejection' || outcome === 'rollback'
    || outcome === 'compensation' || outcome === 'contradiction' || outcome === 'incident';
  const confirmed = outcome === 'confirmed';
  if (!scored || (!adverse && !confirmed)) {
    return Object.freeze({
      agrees: null,
      predictedHigh: scored ? score >= highFloor : null,
      reason: !scored ? 'prediction_unscored' : 'outcome_unknown_or_censored',
    });
  }
  const predictedHigh = score >= highFloor;
  const agrees = adverse ? predictedHigh : !predictedHigh;
  return Object.freeze({
    agrees,
    predictedHigh,
    reason: agrees
      ? (adverse ? 'high_estimate_met_adverse_outcome' : 'low_estimate_confirmed')
      : (adverse ? 'missed_adverse_outcome' : 'false_alarm'),
  });
}
