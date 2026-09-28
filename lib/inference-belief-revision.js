'use strict';

const { readPredictionPairs } = require('./prediction-outcome-pairs');
const {
  DERIVED_RECORD_SCHEMA_VERSION,
} = require('./inference-derived-record');

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

function calibrateRuleBelief(input = {}, opts = {}) {
  let ruleId;
  let declaredConfidence;
  let pairs;
  let effectEvidence;
  let at;
  let minSamples;
  let defeatBelow;
  let materialDelta;
  let previousConfidence;

  try {
    ruleId = nonEmpty(input.ruleId, 'ruleId');
    declaredConfidence = boundedConfidence(input.declaredConfidence, 'declaredConfidence');
    pairs = normalizePairs(input.pairs || {});
    effectEvidence = normalizeEffectEvidence(input.effectEvidence || []);
    at = isoTimestamp(input.at, 'at');
    minSamples = boundedPositiveInteger(opts.minSamples, DEFAULT_MIN_SAMPLES, 'minSamples');
    defeatBelow = boundedConfidence(
      opts.defeatBelow === undefined ? DEFAULT_DEFEAT_BELOW : opts.defeatBelow,
      'defeatBelow',
    );
    materialDelta = boundedConfidence(
      opts.materialDelta === undefined ? DEFAULT_MATERIAL_DELTA : opts.materialDelta,
      'materialDelta',
    );
    previousConfidence = previousSystemConfidence(input.previous || null);
  } catch (error) {
    return Object.freeze({
      schemaVersion: RULE_BELIEF_SCHEMA_VERSION,
      status: CALIBRATION_STATUS.INVALID,
      reason: error && error.message ? error.message : 'invalid_input',
      ruleId: typeof input.ruleId === 'string' ? input.ruleId : '',
      declaredConfidence: null,
      calibratedConfidence: null,
      systemConfidence: null,
      observedSamples: 0,
      observedSuccesses: 0,
      observedFailures: 0,
      countedDecisionIds: Object.freeze([]),
      ignoredDecisionIds: Object.freeze([]),
      history: Object.freeze([]),
    });
  }

  const selected = selectRulePairs(pairs, ruleId, opts.actionClass || null);
  const classified = selected.map((pair) => classifyPair(pair, effectEvidence));
  const counted = classified.filter((item) => item.counted);
  const observedSuccesses = counted.filter((item) => item.success).length;
  const observedFailures = counted.filter((item) => item.adverse).length;
  const observedSamples = counted.length;
  const countedDecisionIds = Object.freeze(counted.map((item) => item.decisionId).sort());
  const ignoredDecisionIds = Object.freeze(
    classified.filter((item) => !item.counted).map((item) => item.decisionId).sort(),
  );

  const basePrevious = previousConfidence === null
    ? declaredConfidence
    : previousConfidence;

  if (observedSamples < minSamples) {
    const event = freezeRuleHistoryEvent({
      at,
      status: CALIBRATION_STATUS.INSUFFICIENT,
      declaredConfidence,
      calibratedConfidence: null,
      systemConfidence: basePrevious,
      observedSamples,
      observedSuccesses,
      observedFailures,
      reason: 'minimum_observed_samples_not_met',
    });
    return Object.freeze({
      schemaVersion: RULE_BELIEF_SCHEMA_VERSION,
      ruleId,
      status: CALIBRATION_STATUS.INSUFFICIENT,
      reason: 'minimum_observed_samples_not_met',
      declaredConfidence,
      calibratedConfidence: null,
      systemConfidence: basePrevious,
      observedSamples,
      observedSuccesses,
      observedFailures,
      countedDecisionIds,
      ignoredDecisionIds,
      history: Object.freeze([
        ...((input.previous && Array.isArray(input.previous.history)) ? input.previous.history : []),
        event,
      ]),
    });
  }

  const calibratedConfidence = posteriorMean(observedSuccesses, observedFailures);
  const allowLoosening = opts.allowLoosening === true;
  const candidateConfidence = allowLoosening
    ? calibratedConfidence
    : Math.min(basePrevious, calibratedConfidence, declaredConfidence);
  const systemConfidence = Number(candidateConfidence.toFixed(6));
  const drop = Number((basePrevious - systemConfidence).toFixed(6));

  let status = CALIBRATION_STATUS.CALIBRATED;
  let reason = 'observed_outcomes_calibrated';
  if (systemConfidence < defeatBelow) {
    status = CALIBRATION_STATUS.DEFEATED;
    reason = 'rule_belief_below_defeat_threshold';
  } else if (drop >= materialDelta) {
    status = CALIBRATION_STATUS.DEGRADED;
    reason = 'material_rule_belief_downgrade';
  }

  const event = freezeRuleHistoryEvent({
    at,
    status,
    declaredConfidence,
    calibratedConfidence,
    systemConfidence,
    observedSamples,
    observedSuccesses,
    observedFailures,
    reason,
  });

  return Object.freeze({
    schemaVersion: RULE_BELIEF_SCHEMA_VERSION,
    ruleId,
    status,
    reason,
    declaredConfidence,
    calibratedConfidence,
    systemConfidence,
    observedSamples,
    observedSuccesses,
    observedFailures,
    countedDecisionIds,
    ignoredDecisionIds,
    history: Object.freeze([
      ...((input.previous && Array.isArray(input.previous.history)) ? input.previous.history : []),
      event,
    ]),
  });
}

function calibrateRuleBeliefFromStore(graph, input = {}, opts = {}) {
  const pairs = readPredictionPairs(graph);
  return calibrateRuleBelief({ ...input, pairs }, opts);
}

function ruleBeliefAt(state, asOf) {
  if (!state || state.schemaVersion !== RULE_BELIEF_SCHEMA_VERSION) {
    throw new TypeError('valid rule belief state is required');
  }
  const boundary = Date.parse(isoTimestamp(asOf, 'asOf'));
  const events = state.history
    .filter((event) => Date.parse(event.at) <= boundary)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (events.length === 0) return null;
  return events[events.length - 1];
}

function derivedBeliefStatus(ruleBelief, opts = {}) {
  if (ruleBelief.status === CALIBRATION_STATUS.DEFEATED) return 'defeated';
  const prior = typeof opts.previousConfidence === 'number'
    ? boundedConfidence(opts.previousConfidence, 'previousConfidence')
    : null;
  if (
    prior !== null
    && prior - ruleBelief.systemConfidence >= (
      opts.materialDelta === undefined ? DEFAULT_MATERIAL_DELTA : boundedConfidence(opts.materialDelta, 'materialDelta')
    )
  ) {
    return 'degraded';
  }
  if (ruleBelief.status === CALIBRATION_STATUS.INSUFFICIENT) return 'insufficient';
  return 'active';
}

function reviseDerivedConclusionBeliefs(records, ruleBelief, opts = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!ruleBelief || ruleBelief.schemaVersion !== RULE_BELIEF_SCHEMA_VERSION) {
    throw new TypeError('valid rule belief state is required');
  }
  const at = isoTimestamp(opts.at, 'at');
  const previousByDerivationId = opts.previousByDerivationId || {};
  if (!previousByDerivationId || typeof previousByDerivationId !== 'object' || Array.isArray(previousByDerivationId)) {
    throw new TypeError('previousByDerivationId must be an object');
  }

  return Object.freeze(records
    .filter((record) =>
      record
      && record.schemaVersion === DERIVED_RECORD_SCHEMA_VERSION
      && record.ruleId === ruleBelief.ruleId
    )
    .sort((left, right) => left.derivationId.localeCompare(right.derivationId))
    .map((record) => {
      const previous = previousByDerivationId[record.derivationId] || null;
      if (previous && previous.schemaVersion !== DERIVED_BELIEF_SCHEMA_VERSION) {
        throw new TypeError(`invalid previous derived belief for ${record.derivationId}`);
      }

      const previousConfidence = previous && typeof previous.systemConfidence === 'number'
        ? previous.systemConfidence
        : null;
      const status = derivedBeliefStatus(ruleBelief, {
        previousConfidence,
        materialDelta: opts.materialDelta,
      });
      const event = Object.freeze({
        at,
        status,
        ruleStatus: ruleBelief.status,
        systemConfidence: ruleBelief.systemConfidence,
        reason: ruleBelief.reason,
      });

      return Object.freeze({
        schemaVersion: DERIVED_BELIEF_SCHEMA_VERSION,
        derivationId: record.derivationId,
        ruleId: record.ruleId,
        status,
        systemConfidence: ruleBelief.systemConfidence,
        history: Object.freeze([
          ...((previous && Array.isArray(previous.history)) ? previous.history : []),
          event,
        ]),
      });
    }));
}

function derivedBeliefAt(state, asOf) {
  if (!state || state.schemaVersion !== DERIVED_BELIEF_SCHEMA_VERSION) {
    throw new TypeError('valid derived belief state is required');
  }
  const boundary = Date.parse(isoTimestamp(asOf, 'asOf'));
  const events = state.history
    .filter((event) => Date.parse(event.at) <= boundary)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (events.length === 0) return null;
  return events[events.length - 1];
}

module.exports = {
  RULE_BELIEF_SCHEMA_VERSION,
  DERIVED_BELIEF_SCHEMA_VERSION,
  CALIBRATION_STATUS,
  EFFECT_KIND,
  calibrateRuleBelief,
  calibrateRuleBeliefFromStore,
  ruleBeliefAt,
  reviseDerivedConclusionBeliefs,
  derivedBeliefAt,
};
