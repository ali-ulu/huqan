'use strict';

/**
 * COG-A (#4391, PR-1): pure, deterministic appraisal of a source-bound
 * observation. Core ring: no I/O, no clock, no randomness.
 *
 * HUQAN's "emotion" is a derived reading of the agent's own decision outcomes,
 * not a claim about a person's feelings. Every dimension must arrive with its
 * provenance; an unknown dimension stays unknown and is never filled with a
 * neutral or zero default. Only labels whose complete evidence is present are
 * emitted; the rest are reported with the reason they were withheld. The
 * result carries signal-only authority: it cannot approve, block or execute.
 *
 * Satisfaction and surprise are the first candidates. Regret additionally
 * requires observed own contribution and a better supported alternative.
 * Anxiety and frustration need a future-goal contract that does not exist
 * yet, so this slice never invents them.
 */

const { createHash } = require('node:crypto');
const { COGNITION_STATUS, AUTHORITY, round6, freezeResult } = require('./contract');
const { isPlainObject } = require('../is-plain-object');
const { stableStringify } = require('../hash-chain');

const SCHEMA_VERSION = 'huqan-cognition-appraisal-v1';
const SATISFACTION_GOAL_MIN = 0.5;
const SURPRISE_UNEXPECTEDNESS_MIN = 0.5;
const REGRET_GOAL_MAX = -0.5;
const REGRET_RESPONSIBILITY_MIN = 0.5;

const DIMENSIONS = Object.freeze([
  'goalImpact', 'unexpectedness', 'uncertainty', 'responsibility', 'controllability',
]);
const FUTURE_LABELS = Object.freeze(['anxiety', 'frustration']);
const INPUT_KEYS = Object.freeze([
  'eventId', 'workspaceId', 'at', 'asOf', ...DIMENSIONS, 'alternative',
]);
const EVIDENCE_KEYS = Object.freeze(['value', 'source', 'workspaceId']);

const text = (value) => typeof value === 'string' && value.trim() !== '';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const timeOf = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);
const hasOnlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

const reject = (reason) => freezeResult({
  schemaVersion: SCHEMA_VERSION, eventId: null, workspaceId: null,
  status: COGNITION_STATUS.REJECT, reason, label: null, labels: [], withheld: [],
  dimensions: {}, unknownDimensions: [], sources: [], sourceDigest: null,
  authority: AUTHORITY.SIGNAL_ONLY,
});

// A dimension is known only when its value and its declared source both exist.
// A value without provenance is not evidence, and a missing dimension is not 0.
function readDimension(input, name) {
  const raw = input[name];
  if (raw === undefined) return { status: 'UNKNOWN', reason: 'evidence_missing' };
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, EVIDENCE_KEYS)) {
    return { status: 'INVALID', reason: `invalid_evidence:${name}` };
  }
  if (raw.workspaceId !== undefined) {
    if (!text(raw.workspaceId)) return { status: 'INVALID', reason: `invalid_evidence:${name}` };
    if (raw.workspaceId !== input.workspaceId) return { status: 'CROSS_WORKSPACE' };
  }
  const low = name === 'goalImpact' ? -1 : 0;
  if (!(finite(raw.value) && raw.value >= low && raw.value <= 1)) {
    return { status: 'INVALID', reason: `invalid_evidence:${name}` };
  }
  if (!text(raw.source)) return { status: 'UNKNOWN', reason: 'source_missing' };
  return { status: 'KNOWN', value: round6(raw.value), source: raw.source.trim() };
}

function readAlternative(input) {
  const raw = input.alternative;
  if (raw === undefined) return { status: 'UNKNOWN', reason: 'alternative_missing' };
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ['better', 'source', 'workspaceId'])) {
    return { status: 'INVALID', reason: 'invalid_evidence:alternative' };
  }
  if (raw.workspaceId !== undefined) {
    if (!text(raw.workspaceId)) return { status: 'INVALID', reason: 'invalid_evidence:alternative' };
    if (raw.workspaceId !== input.workspaceId) return { status: 'CROSS_WORKSPACE' };
  }
  if (typeof raw.better !== 'boolean') return { status: 'INVALID', reason: 'invalid_evidence:alternative' };
  if (!text(raw.source)) return { status: 'UNKNOWN', reason: 'source_missing' };
  return { status: 'KNOWN', better: raw.better, source: raw.source.trim() };
}

function regretWithheldReason(goal, responsibility, alternative) {
  if (goal.status !== 'KNOWN') return 'goal_impact_unknown';
  if (goal.value > REGRET_GOAL_MAX) return 'goal_not_negative';
  if (responsibility.status !== 'KNOWN') {
    return responsibility.reason === 'evidence_missing'
      ? 'responsibility_unknown'
      : (responsibility.reason || 'responsibility_unknown');
  }
  if (responsibility.value < REGRET_RESPONSIBILITY_MIN) return 'own_contribution_insufficient';
  if (alternative.status !== 'KNOWN') return alternative.reason || 'alternative_unknown';
  if (alternative.better !== true) return 'no_better_alternative';
  return null;
}

function deriveLabels(dimensions, alternative) {
  const labels = [];
  const withheld = [];
  const goal = dimensions.goalImpact;
  const unexpectedness = dimensions.unexpectedness;
  const responsibility = dimensions.responsibility;

  if (goal.status !== 'KNOWN') {
    withheld.push({ label: 'satisfaction', reason: goal.reason || 'goal_impact_unknown' });
  } else if (goal.value >= SATISFACTION_GOAL_MIN) {
    labels.push({ label: 'satisfaction', support: { goalImpact: goal.value }, reason: 'goal_progress_observed' });
  } else {
    withheld.push({ label: 'satisfaction', reason: 'goal_below_satisfaction_threshold' });
  }

  if (unexpectedness.status !== 'KNOWN') {
    withheld.push({ label: 'surprise', reason: unexpectedness.reason || 'unexpectedness_unknown' });
  } else if (unexpectedness.value >= SURPRISE_UNEXPECTEDNESS_MIN) {
    labels.push({ label: 'surprise', support: { unexpectedness: unexpectedness.value }, reason: 'unexpected_observation' });
  } else {
    withheld.push({ label: 'surprise', reason: 'unexpectedness_below_threshold' });
  }

  const regretReason = regretWithheldReason(goal, responsibility, alternative);
  if (regretReason === null) {
    labels.push({
      label: 'regret',
      support: { goalImpact: goal.value, responsibility: responsibility.value, alternative: true },
      reason: 'own_action_with_better_alternative',
    });
  } else {
    withheld.push({ label: 'regret', reason: regretReason });
  }

  for (const label of FUTURE_LABELS) withheld.push({ label, reason: 'future_goal_contract_not_established' });
  return { labels, withheld };
}

/**
 * Appraise one source-bound observation.
 *
 * @param {unknown} input - { eventId, workspaceId, at, asOf, goalImpact?,
 *   unexpectedness?, uncertainty?, responsibility?, controllability?,
 *   alternative?: { better, source, workspaceId? } }. Each dimension is
 *   { value, source, workspaceId? }.
 * @returns {Readonly<object>} MEASURED with the justified labels, ABSTAIN when
 *   no label is justified, or REJECT for unusable input.
 */
function appraise(input) {
  if (!isPlainObject(input)) return reject('invalid_input');
  if (!hasOnlyKeys(input, INPUT_KEYS)) return reject('invalid_input');
  if (!text(input.eventId) || !text(input.workspaceId)) return reject('invalid_input');
  const at = timeOf(input.at);
  const asOf = timeOf(input.asOf);
  if (at === null || asOf === null) return reject('invalid_input');
  if (at > asOf) return reject('future_observation');

  const dimensions = {};
  const unknownDimensions = [];
  for (const name of DIMENSIONS) {
    const dim = readDimension(input, name);
    if (dim.status === 'INVALID') return reject(dim.reason);
    if (dim.status === 'CROSS_WORKSPACE') return reject('cross_workspace_evidence');
    if (dim.status === 'KNOWN') {
      dimensions[name] = { status: 'KNOWN', value: dim.value, source: dim.source };
    } else {
      dimensions[name] = { status: 'UNKNOWN', value: null, source: null, reason: dim.reason };
      unknownDimensions.push(name);
    }
  }
  const alternative = readAlternative(input);
  if (alternative.status === 'INVALID') return reject(alternative.reason);
  if (alternative.status === 'CROSS_WORKSPACE') return reject('cross_workspace_evidence');

  const { labels, withheld } = deriveLabels(dimensions, alternative);
  const sources = DIMENSIONS
    .filter((name) => dimensions[name].status === 'KNOWN')
    .map((name) => ({ dimension: name, source: dimensions[name].source }))
    .sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));
  if (alternative.status === 'KNOWN') sources.push({ dimension: 'alternative', source: alternative.source });
  const sourceDigest = createHash('sha256')
    .update(stableStringify({ eventId: input.eventId, workspaceId: input.workspaceId, at: input.at, sources }))
    .digest('hex');

  return freezeResult({
    schemaVersion: SCHEMA_VERSION,
    eventId: input.eventId,
    workspaceId: input.workspaceId,
    at: input.at,
    status: labels.length > 0 ? COGNITION_STATUS.MEASURED : COGNITION_STATUS.ABSTAIN,
    reason: labels.length > 0 ? 'labels_derived' : 'no_label_justified',
    label: labels.length > 0 ? labels[0].label : null,
    labels,
    withheld,
    dimensions,
    unknownDimensions: unknownDimensions.sort(),
    sources,
    sourceDigest,
    authority: AUTHORITY.SIGNAL_ONLY,
  });
}

module.exports = {
  SCHEMA_VERSION, SATISFACTION_GOAL_MIN, SURPRISE_UNEXPECTEDNESS_MIN,
  REGRET_GOAL_MAX, REGRET_RESPONSIBILITY_MIN, DIMENSIONS, FUTURE_LABELS,
  appraise,
};
