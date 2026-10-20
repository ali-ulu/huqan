'use strict';

/**
 * Shared output vocabulary for the COG program (#4060). Pure Core: no I/O,
 * no clock, no randomness. Every cognition module returns frozen results that
 * carry a status and a signal-only authority; none of them can act.
 */

const COGNITION_STATUS = Object.freeze({
  MEASURED: 'MEASURED',
  ABSTAIN: 'ABSTAIN',
  INSUFFICIENT: 'INSUFFICIENT',
  REJECT: 'REJECT',
});

const AUTHORITY = Object.freeze({
  SIGNAL_ONLY: 'SIGNAL_ONLY',
  OBSERVATION_ONLY: 'OBSERVATION_ONLY',
  PROPOSAL_ONLY: 'PROPOSAL_ONLY',
  ROUTING_ADVICE_ONLY: 'ROUTING_ADVICE_ONLY',
  CANDIDATE_ONLY: 'CANDIDATE_ONLY',
});

const ROUND_FACTOR = 1e6;

/** Clamp to [0, 1]; anything that is not a finite number becomes 0 (fail closed). */
function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Round to six decimals; anything that is not a finite number becomes null. */
function round6(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
}

/** Deep-frozen copy of plain objects and arrays; the input is never mutated. */
function freezeResult(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeResult));
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = freezeResult(value[key]);
  return Object.freeze(copy);
}

module.exports = { COGNITION_STATUS, AUTHORITY, clamp01, round6, freezeResult };
