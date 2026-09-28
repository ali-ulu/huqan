'use strict';

const { readPredictionPairs } = require('./prediction-outcome-pairs');
const { DERIVED_RECORD_SCHEMA_VERSION } = require('./inference-derived-record');
const {
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
} = require('./inference-belief-revision-values');

function invalidRuleBelief(input, error) {
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
    if (typeof input.ruleId !== 'string' || input.ruleId.trim() === '') {
      throw new TypeError('ruleId must be a non-empty string');
    }
    ruleId = input.ruleId.trim();
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
    return invalidRuleBelief(input, error);
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
  const priorHistory = input.previous && Array.isArray(input.previous.history)
    ? input.previous.history
    : [];

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
      history: Object.freeze([...priorHistory, event]),
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
    history: Object.freeze([...priorHistory, event]),
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
  const materialDelta = opts.materialDelta === undefined
    ? DEFAULT_MATERIAL_DELTA
    : boundedConfidence(opts.materialDelta, 'materialDelta');
  if (prior !== null && prior - ruleBelief.systemConfidence >= materialDelta) {
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
