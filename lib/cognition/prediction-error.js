'use strict';

/**
 * COG-M2 (#4061): turns "expected vs observed" into one bounded error signal.
 * Pure Core: no I/O, no clock, no randomness. It scores and never acts; a
 * censored, unknown or indeterminate observation ABSTAINs and is never success.
 */

const { COGNITION_STATUS, AUTHORITY, clamp01, round6, freezeResult } = require('./contract');
const { comparePredictionOutcome } = require('../prediction-outcome-pairs');
const { isObserved } = require('../file-effect-sensor');
const { isPlainObject } = require('../is-plain-object');

const SCHEMA_VERSION = 'huqan-cognition-prediction-error-v1';
const SURPRISE_EPSILON = 1e-6;
const SURPRISE_CAP_BITS = 20;
const DEFAULT_SUMMARY_WINDOW = 8;
const MAX_SUMMARY_INPUT = 5000;

const COMMON_FIELDS = ['kind', 'decisionId', 'key', 'at'];
const KIND_FIELDS = Object.freeze({
  risk: ['score', 'outcome'],
  probability: ['p', 'y', 'probabilitySource'],
  state: ['failure', 'keyCount'],
  effect: ['expected', 'observed'],
});

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isFraction = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function finish(input, status, fields) {
  const measured = status === COGNITION_STATUS.MEASURED;
  const signedError = measured ? round6(fields.signedError) : null;
  return freezeResult({
    schemaVersion: SCHEMA_VERSION,
    status,
    kind: isPlainObject(input) && typeof input.kind === 'string' ? input.kind : null,
    decisionId: isPlainObject(input) && typeof input.decisionId === 'string' ? input.decisionId : null,
    key: isPlainObject(input) && typeof input.key === 'string' ? input.key : null,
    signedError,
    magnitude: measured ? round6(clamp01(Math.abs(fields.signedError))) : null,
    surpriseBits: measured && fields.surpriseBits !== undefined ? round6(fields.surpriseBits) : null,
    reason: fields.reason,
    sourceRefs: fields.sourceRefs || [],
    at: fields.at || null,
    authority: AUTHORITY.SIGNAL_ONLY,
  });
}

const reject = (input, reason) => finish(input, COGNITION_STATUS.REJECT, { reason });
const abstain = (input, reason, at) => finish(input, COGNITION_STATUS.ABSTAIN, { reason, at });

function validateShape(input) {
  if (!isPlainObject(input)) return 'invalid_input';
  const fields = KIND_FIELDS[input.kind];
  if (!fields) return 'unknown_kind';
  const unknownField = Object.keys(input).find((name) => !COMMON_FIELDS.includes(name) && !fields.includes(name));
  if (unknownField) return `unknown_field:${unknownField}`;
  if (!isText(input.decisionId) || !isText(input.key)) return 'invalid_identity';
  if (typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at))) return 'invalid_at';
  return null;
}

function riskError(input) {
  const { score = null, outcome = null } = input;
  if (score !== null && !(typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100)) return { rejected: 'invalid_score' };
  const compared = comparePredictionOutcome({ score, outcome });
  if (compared.agrees === null) return { abstained: compared.reason };
  const adverse = compared.agrees ? compared.predictedHigh : !compared.predictedHigh;
  return {
    signedError: (adverse ? 1 : 0) - (compared.predictedHigh ? 1 : 0),
    reason: compared.reason,
    sourceRefs: [`prediction-outcome:prediction:${input.decisionId}`],
  };
}

function probabilityError(input) {
  const { p, y, probabilitySource } = input;
  if (!isFraction(p)) return { rejected: 'invalid_probability' };
  if (y !== 0 && y !== 1) return { rejected: 'invalid_outcome' };
  if (!isText(probabilitySource)) return { abstained: 'probability_source_missing' };
  const chance = y === 1 ? p : 1 - p;
  const signedError = y - p;
  return {
    signedError,
    surpriseBits: Math.min(SURPRISE_CAP_BITS, -Math.log2(Math.max(SURPRISE_EPSILON, chance))),
    reason: signedError === 0 ? 'prediction_matched' : 'observed_outcome_differs',
    sourceRefs: [`prediction-outcome:prediction:${input.decisionId}`],
  };
}

function stateError(input) {
  const { failure, keyCount } = input;
  if (!isPlainObject(failure)) return { rejected: 'invalid_failure' };
  if (failure.status === 'UNKNOWN') return { abstained: 'state_prediction_unknown' };
  const refs = [`causal-failure:${input.decisionId}`];
  if (failure.status === 'CONFIRMED') return { signedError: 0, reason: 'state_confirmed', sourceRefs: refs };
  if (failure.status !== 'MISMATCH' || !Array.isArray(failure.differences)) return { rejected: 'invalid_failure' };
  const differing = failure.differences.length;
  if (!Number.isInteger(keyCount) || keyCount <= 0 || differing > keyCount) return { rejected: 'invalid_key_count' };
  return { signedError: differing / keyCount, reason: 'state_mismatch', sourceRefs: refs };
}

function effectError(input) {
  const { expected, observed } = input;
  if (!isObserved(expected)) return { rejected: 'invalid_expected_effect' };
  if (!isObserved(observed)) return { abstained: 'effect_indeterminate' };
  return {
    signedError: expected === observed ? 0 : 1,
    reason: expected === observed ? 'effect_as_expected' : 'effect_differs',
    sourceRefs: [`file-effect:${input.decisionId}`],
  };
}

const COMPUTE = Object.freeze({ risk: riskError, probability: probabilityError, state: stateError, effect: effectError });

/**
 * @param {object} input one of the four kinds in the #4061 data contract
 * @returns {Readonly<object>} MEASURED, ABSTAIN or REJECT; never throws
 */
function computePredictionError(input) {
  const invalid = validateShape(input);
  if (invalid) return reject(input, invalid);
  const at = new Date(Date.parse(input.at)).toISOString();
  const result = COMPUTE[input.kind](input);
  if (result.rejected) return reject(input, result.rejected);
  if (result.abstained) return abstain(input, result.abstained, at);
  return finish(input, COGNITION_STATUS.MEASURED, { ...result, at });
}

const mean = (values) => (values.length === 0 ? null : round6(values.reduce((sum, v) => sum + v, 0) / values.length));
const byMoment = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0));

/**
 * Recent-vs-older trend of one key's errors. Order is (at, decisionId), so the
 * result does not depend on arrival order. A mean without a full window is null.
 */
function summarizePredictionErrors(errors, { key = null, window = DEFAULT_SUMMARY_WINDOW } = {}) {
  const size = Number.isInteger(window) && window > 0 ? window : DEFAULT_SUMMARY_WINDOW;
  const rows = (Array.isArray(errors) ? errors.slice(0, MAX_SUMMARY_INPUT) : [])
    .filter((row) => isPlainObject(row) && row.schemaVersion === SCHEMA_VERSION && (key === null || row.key === key))
    .sort(byMoment);
  const measured = rows.filter((row) => row.status === COGNITION_STATUS.MEASURED).map((row) => row.magnitude);
  return freezeResult({
    key,
    count: measured.length,
    abstained: rows.filter((row) => row.status === COGNITION_STATUS.ABSTAIN).length,
    meanMagnitude: mean(measured),
    olderMean: measured.length >= 2 * size ? mean(measured.slice(-2 * size, -size)) : null,
    recentMean: measured.length >= size ? mean(measured.slice(-size)) : null,
    window: size,
  });
}

module.exports = {
  SCHEMA_VERSION,
  SURPRISE_EPSILON,
  SURPRISE_CAP_BITS,
  DEFAULT_SUMMARY_WINDOW,
  MAX_SUMMARY_INPUT,
  computePredictionError,
  summarizePredictionErrors,
};
