'use strict';

// #3493 (R38): the bounded, dry-run-first consolidation selector.
//
// "Consolidation" here means choosing which stored memories are safe to
// *offload* out of the default read set via the reversible archive primitive.
// It is a pure selector: it reads records and returns an ordered, capped
// candidate list. It never mutates -- the caller (MemoryLifecycle.consolidate)
// archives each candidate through the receipt-bound archive path, so every
// accepted offload carries a chained receipt and a reason.
//
// Selection policy (the decision the issue left open, made conservative):
//   - Default candidates are `superseded` records only. A superseded record has
//     a live successor, so offloading it loses no reachable knowledge.
//   - `includeLowConfidence` also admits `active` records whose provenance
//     confidence is at or below `maxConfidence` (default 0.25). Off by default:
//     archiving a live record is a knowledge decision, not a housekeeping one.
//   - `olderThanDays` restricts to records whose last update is older than the
//     horizon. Off by default.
// The cap is always enforced and hard-bounded, so one call can never offload an
// unbounded slice of the store.
//
// #4070 (COG-M4, PR-2): `opts.retention` opts into a second, additive policy --
// the reversible-forgetting score. When it is absent the selector above is
// byte-for-byte unchanged. When `retention.enabled === true` the candidate set
// is instead the `active` records whose explicit retention score falls below
// the forgetting threshold, ranked by lib/cognition/forgetting-score.js. The
// score is a proposal only: this module still mutates nothing, and
// MemoryLifecycle still archives each candidate through the receipt-bound path.

const { normalizeWorkspaceId } = require('./memory-store-utils');
const { isPlainObject } = require('./is-plain-object');
const { normalizeRecencyOptions, recencyFactor } = require('./memory-recency-decay');
const { COGNITION_STATUS } = require('./cognition/contract');
const { rankForgetCandidates, FORGET_THRESHOLD } = require('./cognition/forgetting-score');

/** Records whose status makes them eligible under the default policy. */
const DEFAULT_CANDIDATE_STATUSES = Object.freeze(['superseded']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// The forgetting half-life is the caller's parameter (PR-1 keeps it out of the
// pure core); the plan fixes 90 days for the retention policy.
const DEFAULT_RETENTION_HALF_LIFE_DAYS = 90;

function recordConfidence(record) {
  const value = record && record.provenance && record.provenance.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Last-touched instant used by the horizon filter; createdAt when never updated. */
function lastTouchedMs(record) {
  const stamp = record.updatedAt || record.createdAt;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

function resolveLimit(limit) {
  if (limit === undefined) return { ok: true, limit: DEFAULT_LIMIT };
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'limit must be a non-negative integer' } };
  }
  return { ok: true, limit: Math.min(value, MAX_LIMIT) };
}

function resolveHorizon(olderThanDays, now) {
  if (olderThanDays === undefined) return { ok: true, horizonMs: null };
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 0) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'olderThanDays must be a non-negative number' } };
  }
  return { ok: true, horizonMs: now - days * 24 * 60 * 60 * 1000 };
}

/**
 * Resolve the opt-in retention policy. Absent or `enabled !== true` means the
 * default superseded-only selector runs unchanged, so an accidental
 * `retention: {}` cannot silently switch policies.
 * @param {unknown} retention
 * @param {number} now - reference instant in epoch ms
 */
function resolveRetention(retention, now) {
  if (retention === undefined) return { ok: true, enabled: false };
  if (!isPlainObject(retention)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'retention must be an object' } };
  }
  if (retention.enabled !== true) return { ok: true, enabled: false };
  const halfLifeDays = retention.halfLifeDays === undefined ? DEFAULT_RETENTION_HALF_LIFE_DAYS : retention.halfLifeDays;
  const resolved = normalizeRecencyOptions({ halfLifeDays, asOf: new Date(now).toISOString() });
  if (!resolved.ok) return { ok: false, error: { code: 'INVALID_INPUT', message: resolved.message } };
  return { ok: true, enabled: true, recency: resolved };
}

// The record carries only what its author declared: the content kind and the
// metadata an operator wrote (importance and its source, use count, replay age,
// pin/dependency flags). Recency is computed here from the record's own
// timestamp, because the pure core takes it as an input. An absent importance
// stays absent -- the score abstains rather than inventing a small number.
function scoreInputFor(record, recency) {
  const metadata = isPlainObject(record.metadata) ? record.metadata : {};
  const content = isPlainObject(record.content) ? record.content : {};
  return {
    memoryId: record.memoryId,
    status: record.status,
    kind: content.kind !== undefined ? content.kind : metadata.kind,
    importance: metadata.importance,
    importanceSource: metadata.importanceSource,
    recency: recencyFactor(record, recency),
    uses: metadata.uses,
    replayedWithinDays: metadata.replayedWithinDays,
    pinned: metadata.pinned,
    dependencyProtected: metadata.dependencyProtected,
    createdAt: record.createdAt,
  };
}

/**
 * Select archive candidates by retention score (#4070 PR-2). Only `active`
 * records with an explicit, sourced importance and a score below the forgetting
 * threshold qualify; policy/capability, pinned and dependency-protected records
 * are refused by the core guards. Deterministic and capped exactly like the
 * default selector.
 */
function selectRetentionCandidates(records, retention, limit) {
  const inputs = records.map((record) => scoreInputFor(record, retention.recency));
  const ranked = rankForgetCandidates(inputs, { limit: MAX_LIMIT });
  const eligible = ranked.status === COGNITION_STATUS.MEASURED ? ranked.candidates : [];
  const candidates = eligible.slice(0, limit).map((score) => ({
    memoryId: score.memoryId,
    status: 'active',
    retention: score.retention,
    components: score.components,
    reason: `retention ${score.retention} below forget threshold ${FORGET_THRESHOLD}`,
  }));
  return { ok: true, candidates, scanned: records.length, total: eligible.length };
}

/**
 * Select archive candidates for one workspace.
 *
 * @param {object} context - { list(opts) => {ok,memories} } over the memory store
 * @param {object} opts - { workspaceId, dryRun?, limit?, olderThanDays?,
 *   includeLowConfidence?, maxConfidence?, now?, retention? }
 * @returns {{ok:boolean, candidates?:object[], scanned?:number, total?:number, error?:object}}
 */
function selectConsolidationCandidates(context, opts = {}) {
  const workspaceId = normalizeWorkspaceId(opts.workspaceId) || 'default';
  const limitResult = resolveLimit(opts.limit);
  if (!limitResult.ok) return limitResult;
  const now = Number.isFinite(Date.parse(opts.now)) ? Date.parse(opts.now) : Date.now();
  const horizonResult = resolveHorizon(opts.olderThanDays, now);
  if (!horizonResult.ok) return horizonResult;
  const retentionResult = resolveRetention(opts.retention, now);
  if (!retentionResult.ok) return retentionResult;

  // includeTombstoned reveals the full audit set (active + superseded + ...);
  // the selector then applies its own status policy rather than trusting the
  // default read to have already filtered.
  const listed = context.list({ workspaceId, includeTombstoned: true, limit: Infinity });
  if (!listed || listed.ok !== true) {
    return { ok: false, error: { code: 'READ_FAILED', message: 'consolidation selection could not read the workspace' } };
  }
  const records = Array.isArray(listed.memories) ? listed.memories : [];

  if (retentionResult.enabled) {
    return selectRetentionCandidates(records, retentionResult, limitResult.limit);
  }

  const maxConfidence = typeof opts.maxConfidence === 'number' && Number.isFinite(opts.maxConfidence)
    ? opts.maxConfidence
    : 0.25;
  const includeLowConfidence = opts.includeLowConfidence === true;

  const candidates = [];
  for (const record of records) {
    if (DEFAULT_CANDIDATE_STATUSES.includes(record.status)) {
      // superseded: eligible by default
    } else if (includeLowConfidence && record.status === 'active') {
      const confidence = recordConfidence(record);
      if (confidence === null || confidence > maxConfidence) continue;
    } else {
      continue;
    }
    if (horizonResult.horizonMs !== null) {
      const touched = lastTouchedMs(record);
      if (touched === null || touched > horizonResult.horizonMs) continue;
    }
    candidates.push({
      memoryId: record.memoryId,
      status: record.status,
      createdAt: record.createdAt,
      confidence: recordConfidence(record),
      reason: record.status === 'superseded'
        ? 'superseded by a live successor'
        : `active with confidence ${recordConfidence(record)} at or below ${maxConfidence}`,
    });
  }

  // Deterministic: oldest first, id as the tiebreak, so a capped run is stable
  // across calls and two operators see the same slice.
  candidates.sort((left, right) => {
    const leftMs = Date.parse(left.createdAt);
    const rightMs = Date.parse(right.createdAt);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
    return String(left.memoryId).localeCompare(String(right.memoryId));
  });

  return { ok: true, candidates: candidates.slice(0, limitResult.limit), scanned: records.length, total: candidates.length };
}

module.exports = {
  selectConsolidationCandidates,
  DEFAULT_CANDIDATE_STATUSES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
