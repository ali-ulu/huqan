'use strict';

/**
 * COG-M4 (#4070, PR-1): pure, deterministic retention scoring for the
 * reversible-forgetting selector. Core ring: no I/O, no clock, no randomness.
 *
 * Forgetting in HUQAN is a *reversible archive*, never a delete. This module
 * only ranks; MemoryLifecycle.consolidate archives through the receipt-bound
 * path and restore brings a record back. A low score is a proposal to offload,
 * not a decision, and it carries no action authority.
 *
 *   retention = importance * recency * usage
 *
 * Importance is the gate: a record whose importance (or its declared source)
 * is unknown is never eligible, however old or unused it looks, because an
 * unknown quantity is not a small one. Unknown recency or usage is treated as
 * 1 (no discount) and reported in `unknownComponents`, so the age/usage effect
 * stays visible instead of being silently fabricated. Confidence and the
 * absolute value of a reward valence are not importance.
 */

const { COGNITION_STATUS, AUTHORITY, round6, freezeResult } = require('./contract');
const { isPlainObject } = require('../is-plain-object');

const SCHEMA_VERSION = 'huqan-cognition-forgetting-v1';
// Half-life the Adapters caller passes to memory-recency-decay's recencyFactor
// when it derives `recency`; the pure core receives the factor, never a clock.
const FORGET_HALF_LIFE_DAYS = 90;
const USAGE_FLOOR = 0.2;
const USAGE_HALF = 2;
const FORGET_THRESHOLD = 0.05;
const REPLAY_PROTECT_DAYS = 30;
const REPLAY_PROTECT_FLOOR = 0.5;
const PROTECTED_KINDS = Object.freeze(['policy', 'capability']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const text = (value) => typeof value === 'string' && value.trim() !== '';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const inUnit = (value) => finite(value) && value >= 0 && value <= 1;
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const timeOf = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);

const reject = (reason) => freezeResult({
  schemaVersion: SCHEMA_VERSION, memoryId: null, status: COGNITION_STATUS.REJECT, reason,
  retention: null, eligible: false, authority: AUTHORITY.SIGNAL_ONLY,
});

// Getirme etkisi (retrieval practice): each use strengthens the trace, with a
// floor so a never-used record is discounted but not zeroed.
function usageFactor(uses) {
  return USAGE_FLOOR + (1 - USAGE_FLOOR) * (1 - 2 ** (-uses / USAGE_HALF));
}

/**
 * Score one memory record for reversible forgetting.
 *
 * @param {unknown} record - { memoryId, status, kind, importance, importanceSource,
 *   recency?, uses?, replayedWithinDays?, pinned?, dependencyProtected? }
 * @returns {Readonly<object>} MEASURED with a retention score, or ABSTAIN when
 *   importance is unknown, or REJECT for an unusable record.
 */
function retentionScore(record) {
  if (!isPlainObject(record) || !text(record.memoryId)) return reject('invalid_input');
  const memoryId = record.memoryId;

  // Importance is known only from an explicit value AND its declared source.
  // Confidence or |valence| standing in for it would be a fabricated reading.
  if (!(inUnit(record.importance) && text(record.importanceSource))) {
    return freezeResult({
      schemaVersion: SCHEMA_VERSION, memoryId, status: COGNITION_STATUS.ABSTAIN,
      retention: null, eligible: false, reason: 'importance_unknown', authority: AUTHORITY.SIGNAL_ONLY,
    });
  }
  const importance = record.importance;

  // An unknown recency or usage applies no discount (factor 1) and is named in
  // unknownComponents; the known factor's effect stays explicit and separate.
  const unknownComponents = [];
  const recencyKnown = inUnit(record.recency);
  const recency = recencyKnown ? record.recency : 1;
  if (!recencyKnown) unknownComponents.push('recency');
  const usageKnown = finite(record.uses) && record.uses >= 0;
  const usage = usageKnown ? usageFactor(record.uses) : 1;
  if (!usageKnown) unknownComponents.push('uses');

  let retention = importance * recency * usage;
  const replayedWithinDays = finite(record.replayedWithinDays) && record.replayedWithinDays >= 0
    ? record.replayedWithinDays
    : null;
  if (replayedWithinDays !== null && replayedWithinDays <= REPLAY_PROTECT_DAYS) {
    retention = Math.max(retention, REPLAY_PROTECT_FLOOR);
  }
  retention = round6(retention);

  // Archive-eligibility guards, in order. Any failure keeps the record out of
  // the candidate set however low the score is. A missing dependency view is
  // not "unprotected": it withholds automatic eligibility.
  let reason = null;
  if (record.status !== 'active') reason = 'not_active';
  else if (PROTECTED_KINDS.includes(record.kind)) reason = 'protected_kind';
  else if (record.pinned === true) reason = 'pinned';
  else if (typeof record.dependencyProtected !== 'boolean') reason = 'dependency_view_unknown';
  else if (record.dependencyProtected === true) reason = 'dependency_protected';
  else if (retention >= FORGET_THRESHOLD) reason = 'retention_above_threshold';

  const result = {
    schemaVersion: SCHEMA_VERSION, memoryId, status: COGNITION_STATUS.MEASURED, retention,
    components: { importance, recency: round6(recency), usage: round6(usage) },
    unknownComponents: unknownComponents.sort(), eligible: reason === null,
    authority: AUTHORITY.SIGNAL_ONLY,
  };
  if (reason !== null) result.reason = reason;
  return freezeResult(result);
}

/**
 * Rank the forget candidates of a record set, lowest retention first, then
 * oldest createdAt, then memoryId. Capped at MAX_LIMIT so one call can never
 * propose an unbounded slice; the caller keeps its own limit too.
 *
 * @param {unknown} records
 * @param {{ limit?: number }} [options]
 */
function rankForgetCandidates(records, options = {}) {
  const finish = (status, reason, candidates = [], skipped = []) => freezeResult({
    schemaVersion: SCHEMA_VERSION, status, reason, candidates, skipped, authority: AUTHORITY.SIGNAL_ONLY,
  });
  if (!Array.isArray(records)) return finish(COGNITION_STATUS.REJECT, 'invalid_input');
  if (!isPlainObject(options) || Object.keys(options).some((key) => key !== 'limit')) {
    return finish(COGNITION_STATUS.REJECT, 'invalid_options');
  }
  const limit = options.limit === undefined ? DEFAULT_LIMIT : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
    return finish(COGNITION_STATUS.REJECT, 'invalid_limit');
  }

  const scored = records.map((record) => ({ record, score: retentionScore(record) }));
  const skipped = scored
    .filter(({ score }) => !(score.status === COGNITION_STATUS.MEASURED && score.eligible))
    .map(({ score }) => ({ memoryId: score.memoryId, status: score.status, reason: score.reason }))
    .sort((a, b) => compareText(String(a.memoryId), String(b.memoryId)));
  const compareCreatedAt = (a, b) => {
    const ta = timeOf(a.record.createdAt);
    const tb = timeOf(b.record.createdAt);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    return compareText(String(a.record.createdAt ?? ''), String(b.record.createdAt ?? ''));
  };
  const candidates = scored
    .filter(({ score }) => score.status === COGNITION_STATUS.MEASURED && score.eligible)
    .sort((a, b) => (a.score.retention - b.score.retention)
      || compareCreatedAt(a, b)
      || compareText(a.record.memoryId, b.record.memoryId))
    .slice(0, limit)
    .map(({ score }) => score);

  if (candidates.length === 0) return finish(COGNITION_STATUS.INSUFFICIENT, 'no_forget_candidates', candidates, skipped);
  return finish(COGNITION_STATUS.MEASURED, 'ranked_forget_candidates', candidates, skipped);
}

module.exports = {
  SCHEMA_VERSION, FORGET_HALF_LIFE_DAYS, USAGE_FLOOR, USAGE_HALF, FORGET_THRESHOLD,
  REPLAY_PROTECT_DAYS, REPLAY_PROTECT_FLOOR, PROTECTED_KINDS, DEFAULT_LIMIT, MAX_LIMIT,
  retentionScore, rankForgetCandidates,
};
