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

const COUNTER_EVIDENCE_KIND = Object.freeze({
  SUPPORT_INVALIDATION: 'support_invalidation',
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

function sortedUniqueStrings(values, label) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return [...new Set(values.map((value) => nonEmpty(value, label)))].sort();
}

function normalizeEffectEvidence(input = []) {
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
    map.set(decisionId, Object.freeze({
      kind,
      sourceEventRefs: Object.freeze(sortedUniqueStrings(entry.sourceEventRefs, 'effectEvidence.sourceEventRefs')),
    }));
  }
  return map;
}

function normalizeCounterEvidence(input = [], ruleId) {
  if (input === undefined || input === null) return Object.freeze([]);
  if (!Array.isArray(input)) throw new TypeError('counterEvidence must be an array');
  const selected = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') throw new TypeError('counter evidence entries must be objects');
    const evidenceId = nonEmpty(entry.evidenceId, 'counterEvidence.evidenceId');
    const entryRuleId = nonEmpty(entry.ruleId, 'counterEvidence.ruleId');
    const decisionId = nonEmpty(entry.decisionId, 'counterEvidence.decisionId');
    const kind = String(entry.kind || '').trim();
    if (!Object.values(COUNTER_EVIDENCE_KIND).includes(kind)) {
      throw new TypeError('counterEvidence.kind is unsupported');
    }
    const sourceEventRefs = sortedUniqueStrings(entry.sourceEventRefs, 'counterEvidence.sourceEventRefs');
    if (sourceEventRefs.length === 0) {
      throw new TypeError('counterEvidence.sourceEventRefs must identify the source event');
    }
    if (entryRuleId !== ruleId) continue;
    selected.push(Object.freeze({
      origin: 'counter',
      evidenceId: `counter:${evidenceId}`,
      decisionId,
      counted: true,
      success: false,
      adverse: true,
      effectKind: EFFECT_KIND.OBSERVED,
      sourceEventRefs: Object.freeze(sourceEventRefs),
      reason: `observed_${kind}`,
    }));
  }
  return Object.freeze(selected.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
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
  const effect = effectEvidence.get(pair.decisionId) || Object.freeze({ kind: EFFECT_KIND.UNKNOWN, sourceEventRefs: Object.freeze([]) });
  const effectKind = effect.kind;
  const base = {
    origin: 'pair',
    evidenceId: `decision:${pair.decisionId}`,
    decisionId: pair.decisionId,
    effectKind,
    sourceEventRefs: effect.sourceEventRefs,
  };

  if (!outcomeState) {
    return Object.freeze({
      ...base,
      counted: false,
      success: false,
      adverse: false,
      effectKind,
      reason: 'outcome_missing',
    });
  }
  if (outcomeState === 'censored') {
    return Object.freeze({
      ...base,
      counted: false,
      success: false,
      adverse: false,
      effectKind,
      reason: 'outcome_censored',
    });
  }
  if (effectKind !== EFFECT_KIND.OBSERVED) {
    return Object.freeze({
      ...base,
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
      ...base,
      counted: true,
      success: true,
      adverse: false,
      effectKind,
      reason: 'observed_confirmation',
    });
  }
  if (ADVERSE_OUTCOMES.has(outcomeState)) {
    return Object.freeze({
      ...base,
      counted: true,
      success: false,
      adverse: true,
      effectKind,
      reason: `observed_${outcomeState}`,
    });
  }

  return Object.freeze({
    ...base,
    counted: false,
    success: false,
    adverse: false,
    effectKind,
    reason: 'outcome_not_calibration_authority',
  });
}

function independentObservationGroups(observations) {
  const items = observations
    .filter((item) => item && item.counted)
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const parent = items.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) current = parent[current];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = current;
      index = next;
    }
    return current;
  };
  const union = (left, right) => {
    const l = find(left);
    const r = find(right);
    if (l !== r) parent[Math.max(l, r)] = Math.min(l, r);
  };
  const owner = new Map();
  items.forEach((item, index) => {
    const refs = item.sourceEventRefs.length > 0
      ? item.sourceEventRefs
      : [`evidence:${item.evidenceId}`];
    for (const ref of refs) {
      if (owner.has(ref)) union(index, owner.get(ref));
      else owner.set(ref, index);
    }
  });
  const grouped = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(item);
  });
  return Object.freeze([...grouped.values()].map((members) => {
    const sorted = members.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    const pairDecisionIds = [...new Set(sorted.filter((item) => item.origin === 'pair').map((item) => item.decisionId))].sort();
    const adverse = sorted.some((item) => item.adverse);
    return Object.freeze({
      representativeDecisionId: pairDecisionIds[0] || sorted[0].decisionId,
      memberEvidenceIds: Object.freeze(sorted.map((item) => item.evidenceId)),
      pairDecisionIds: Object.freeze(pairDecisionIds),
      correlatedDecisionIds: Object.freeze(pairDecisionIds.slice(1)),
      sourceEventRefs: Object.freeze([...new Set(sorted.flatMap((item) => item.sourceEventRefs))].sort()),
      success: !adverse && sorted.some((item) => item.success),
      adverse,
    });
  }).sort((left, right) => left.memberEvidenceIds[0].localeCompare(right.memberEvidenceIds[0])));
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
    correlatedSamples: event.correlatedSamples || 0,
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

/**
 * The single predicate for "may this rule's belief admit a new conclusion?".
 *
 * A rule is blocked once its calibrated belief is defeated, materially
 * degraded, or its system confidence has fallen below the confidence it
 * declared. `insufficient` (not enough independent evidence yet) is not
 * negative evidence and does not block. Both admission paths (the CLI
 * runtime and the kernel admission seam) call this so negative evidence
 * reaches the intake decision the same way in both. A rule with no belief at
 * all is not blocked here: "never calibrated" is the caller's policy, not
 * negative evidence.
 */
function ruleAdmissionBlocked(beliefs, ruleId) {
  const list = Array.isArray(beliefs) ? beliefs : [];
  const belief = list.find((item) => item && item.ruleId === ruleId);
  if (!belief) return false;
  if (
    belief.status === CALIBRATION_STATUS.DEFEATED
    || belief.status === CALIBRATION_STATUS.DEGRADED
    || belief.status === CALIBRATION_STATUS.INVALID
  ) {
    return true;
  }
  return typeof belief.systemConfidence === 'number'
    && typeof belief.declaredConfidence === 'number'
    && belief.systemConfidence < belief.declaredConfidence;
}

module.exports = {
  RULE_BELIEF_SCHEMA_VERSION,
  DERIVED_BELIEF_SCHEMA_VERSION,
  CALIBRATION_STATUS,
  EFFECT_KIND,
  COUNTER_EVIDENCE_KIND,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_DEFEAT_BELOW,
  DEFAULT_MATERIAL_DELTA,
  boundedConfidence,
  boundedPositiveInteger,
  isoTimestamp,
  normalizeEffectEvidence,
  normalizeCounterEvidence,
  normalizePairs,
  selectRulePairs,
  classifyPair,
  independentObservationGroups,
  posteriorMean,
  freezeRuleHistoryEvent,
  previousSystemConfidence,
  ruleAdmissionBlocked,
};
