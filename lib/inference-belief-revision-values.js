'use strict';

const RULE_BELIEF_SCHEMA_VERSION = 'huqan.rule-belief.v1';
const DERIVED_BELIEF_SCHEMA_VERSION = 'huqan.derived-belief.v1';

const CALIBRATION_STATUS = Object.freeze({
  INSUFFICIENT: 'insufficient',
  CALIBRATED: 'calibrated',
  DEGRADED: 'degraded',
  DEFEATED: 'defeated',
  INVALID: 'invalid',
});

const EFFECT_KIND = Object.freeze({
  OBSERVED: 'observed',
  REPORTED: 'reported',
  UNKNOWN: 'unknown',
});

const ADVERSE_OUTCOMES = new Set([
  'reviewer-rejection',
  'rollback',
  'compensation',
  'contradiction',
  'incident',
]);

const POSITIVE_OUTCOMES = new Set(['confirmed']);

const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_DEFEAT_BELOW = 0.25;
const DEFAULT_MATERIAL_DELTA = 0.1;

function boundedConfidence(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a number between 0 and 1`);
  }
  return value;
}

function boundedPositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be an integer >= 1`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function isoTimestamp(value, label) {
  const text = nonEmpty(value, label);
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(text).toISOString();
}

function normalizeEffectEvidence(input = {}) {
  const map = new Map();
  if (input === undefined || input === null) return map;
  if (!Array.isArray(input)) throw new TypeError('effectEvidence must be an array');
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') throw new TypeError('effect evidence entries must be objects');
    const decisionId = nonEmpty(entry.decisionId, 'effectEvidence.decisionId');
    const kind = String(entry.kind || '').trim();
    if (!Object.values(EFFECT_KIND).includes(kind)) {
      throw new TypeError('effectEvidence.kind must be observed, reported or unknown');
    }
    if (map.has(decisionId)) throw new TypeError(`duplicate effect evidence for ${decisionId}`);
    map.set(decisionId, kind);
  }
  return map;
}

function normalizePairs(pairsInput) {
  if (!pairsInput || typeof pairsInput !== 'object' || Array.isArray(pairsInput)) {
    throw new TypeError('pairs must be an object keyed by decisionId');
  }
  return Object.values(pairsInput)
    .filter((pair) => pair && typeof pair === 'object' && typeof pair.decisionId === 'string')
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}

function selectRulePairs(pairs, ruleId, actionClass = null) {
  const expectedActionClass = actionClass || `inference-rule:${ruleId}`;
  return pairs.filter((pair) =>
    pair.prediction
    && pair.prediction.actionClass === expectedActionClass
  );
}

function classifyPair(pair, effectEvidence) {
  const outcomeState = pair.outcome && typeof pair.outcome.state === 'string'
    ? pair.outcome.state
    : '';
  const effectKind = effectEvidence.get(pair.decisionId) || EFFECT_KIND.UNKNOWN;

  if (!outcomeState) {
    return Object.freeze({
      decisionId: pair.decisionId,
      counted: false,
      success: false,
      adverse: false,
      effectKind,
      reason: 'outcome_missing',
    });
  }
  if (outcomeState === 'censored') {
    return Object.freeze({
      decisionId: pair.decisionId,
      counted: false,
      success: false,
      adverse: false,
      effectKind,
      reason: 'outcome_censored',
    });
  }
  if (effectKind !== EFFECT_KIND.OBSERVED) {
    return Object.freeze({
      decisionId: pair.decisionId,
      counted: false,
      success: false,
      adverse: false,
      effectKind,
      reason: effectKind === EFFECT_KIND.REPORTED
        ? 'reported_effect_not_observed'
        : 'effect_not_observed',
    });
  }

  if (POSITIVE_OUTCOMES.has(outcomeState)) {
    return Object.freeze({
      decisionId: pair.decisionId,
      counted: true,
      success: true,
      adverse: false,
      effectKind,
      reason: 'observed_confirmation',
    });
  }
  if (ADVERSE_OUTCOMES.has(outcomeState)) {
    return Object.freeze({
      decisionId: pair.decisionId,
      counted: true,
      success: false,
      adverse: true,
      effectKind,
      reason: `observed_${outcomeState}`,
    });
  }

  return Object.freeze({
    decisionId: pair.decisionId,
    counted: false,
    success: false,
    adverse: false,
    effectKind,
    reason: 'outcome_not_calibration_authority',
  });
}

function posteriorMean(successes, failures) {
  return (successes + 1) / (successes + failures + 2);
}

function freezeRuleHistoryEvent(event) {
  return Object.freeze({
    at: event.at,
    status: event.status,
    declaredConfidence: event.declaredConfidence,
    calibratedConfidence: event.calibratedConfidence,
    systemConfidence: event.systemConfidence,
    observedSamples: event.observedSamples,
    observedSuccesses: event.observedSuccesses,
    observedFailures: event.observedFailures,
    reason: event.reason,
  });
}

function previousSystemConfidence(previous) {
  if (!previous) return null;
  if (
    previous.schemaVersion !== RULE_BELIEF_SCHEMA_VERSION
    || typeof previous.systemConfidence !== 'number'
  ) {
    throw new TypeError('previous rule belief state is invalid');
  }
  return boundedConfidence(previous.systemConfidence, 'previous.systemConfidence');
}

module.exports = {
  RULE_BELIEF_SCHEMA_VERSION,
  DERIVED_BELIEF_SCHEMA_VERSION,
  CALIBRATION_STATUS,
  EFFECT_KIND,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_DEFEAT_BELOW,
  DEFAULT_MATERIAL_DELTA,
  boundedConfidence,
  boundedPositiveInteger,
  isoTimestamp,
  normalizeEffectEvidence,
  normalizePairs,
  selectRulePairs,
  classifyPair,
  posteriorMean,
  freezeRuleHistoryEvent,
  previousSystemConfidence,
};
