'use strict';

/**
 * Computed reverification horizon for an admitted write (#2795).
 *
 * `lib/memory-admission-gate.js` already accepts a caller-*declared*
 * `expiresAt` (#2017) and stores it on the admission receipt untouched. This
 * module is the missing half: a horizon the gate *derives* from the same
 * risk input it already scores every request on (#2505's taxonomy,
 * `lib/risk-scale.js`), for a request that declared no shelf life of its
 * own.
 *
 * Deliberately not a blanket TTL. Higher-risk writes -- the ones most likely
 * to rest on authority that can change underneath them (a permission, a
 * role, a config) -- get a shorter horizon; a LOW-risk write gets none at
 * all, because forcing reverification on every low-stakes fact would make
 * the mechanism noise rather than signal.
 *
 * Pure, no I/O. `computeReverificationHorizon` never reads or writes
 * `expiresAt` -- the caller (`lib/memory-admission-gate.js`) decides whether
 * a declared expiry takes precedence.
 */

const { riskLevelForScore } = require('./risk-scale');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Horizon length per risk level, in milliseconds. `null` means "no computed
 * horizon" -- a LOW-risk write needs no forced reverification.
 *
 * CRITICAL's 24h matches the closest existing precedent in this codebase,
 * `MAX_CASE_LIFETIME_MS` in lib/human-oversight-approval-runtime-primitives.js
 * (a human-oversight case's own lifetime cap) -- a different mechanism on a
 * different object, but the same judgment that a day is the longest a
 * CRITICAL-stakes claim should go unre-examined.
 */
const HORIZON_MS_BY_RISK_LEVEL = Object.freeze({
  critical: DAY_MS,
  high: 7 * DAY_MS,
  medium: 30 * DAY_MS,
  low: null,
});

/**
 * The computed reverification horizon for a request, as an ISO timestamp, or
 * `null` when the risk level has none (unrecognized/absent score, or LOW).
 *
 * @param {object} input
 * @param {number} input.riskScore  0-100, same score the gate already scores
 *   the request on.
 * @param {string} [input.createdAt] ISO timestamp the horizon is measured
 *   from; defaults to now. An unparseable value returns `null` rather than
 *   guessing.
 */
function computeReverificationHorizon({ riskScore, createdAt } = {}) {
  const level = riskLevelForScore(riskScore);
  if (!level) return null;
  const horizonMs = HORIZON_MS_BY_RISK_LEVEL[level];
  if (!horizonMs) return null;
  const baseMs = createdAt === undefined ? Date.now() : Date.parse(createdAt);
  if (Number.isNaN(baseMs)) return null;
  return new Date(baseMs + horizonMs).toISOString();
}

/**
 * Set `metadata.reverificationHorizon` from a declared expiry or, absent
 * one, a computed one -- the single decision lib/memory-admission-gate.js's
 * receipt builder needs, kept here so that file's own line budget (already
 * at its recorded ceiling) does not have to carry this logic too. A declared
 * `expiresAt` always wins and is never overwritten; `metadata` is mutated
 * in place and returned for convenience.
 */
function applyReverificationHorizon(metadata, { expiresAt, riskScore, createdAt } = {}) {
  const horizon = expiresAt || computeReverificationHorizon({ riskScore, createdAt });
  if (horizon) metadata.reverificationHorizon = horizon;
  return metadata;
}

module.exports = {
  HORIZON_MS_BY_RISK_LEVEL,
  computeReverificationHorizon,
  applyReverificationHorizon,
};
