'use strict';

// Search-time recency ranking for memory queries (#3492, R37).
//
// Opt-in through MemoryStore.query({ retrievalMode: 'recency', recency: {...} })
// or the memory-query surfaces (MCP huqan.memory_query, CLI `memory-query
// --mode recency`, GET /api/memory/query). The default substring path never
// reaches this module, and nothing here mutates a record: the factor is a pure
// function of the record's own timestamp and the caller's `asOf`.
//
// Determinism is the whole point. The factor is a closed-form half-life decay
// rounded to a fixed number of decimals, so the same records and the same
// `asOf` order identically on every platform and every run. An unparseable or
// absent timestamp is not a small factor -- it is *unresolved*, and an
// unresolved record is ranked last rather than silently treated as ancient
// (the same rule K1 uses for an unparseable frame time).
const SCORE_DECIMALS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_DAYS = 30;
const MIN_HALF_LIFE_DAYS = 0.001;
const MAX_HALF_LIFE_DAYS = 3650;

// `now` is the caller's reference instant. `asOf` is accepted as a string or a
// Date; an absent one means "now". It is read once so every record in one
// query is measured against the same instant.
function resolveAsOf(value) {
  if (value === undefined || value === null || value === '') return { ok: true, asOf: Date.now() };
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return { ok: false, message: 'asOf must be an ISO timestamp' };
  return { ok: true, asOf: parsed };
}

function round(value) {
  return Number(value.toFixed(SCORE_DECIMALS));
}

/**
 * Validate the recency options. Returns the resolved half-life and instant so
 * a caller measures every record against one `asOf`, never a per-record `now`.
 * @param {object} [opts] - { halfLifeDays?, asOf? }
 */
function normalizeRecencyOptions(opts = {}) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    return { ok: false, message: 'recency must be an object' };
  }
  const halfLifeDays = opts.halfLifeDays === undefined ? DEFAULT_HALF_LIFE_DAYS : Number(opts.halfLifeDays);
  if (!Number.isFinite(halfLifeDays) || halfLifeDays < MIN_HALF_LIFE_DAYS || halfLifeDays > MAX_HALF_LIFE_DAYS) {
    return { ok: false, message: `recency.halfLifeDays must be a number from ${MIN_HALF_LIFE_DAYS} to ${MAX_HALF_LIFE_DAYS}` };
  }
  const resolved = resolveAsOf(opts.asOf);
  if (!resolved.ok) return resolved;
  return { ok: true, halfLifeDays, asOf: resolved.asOf };
}

/**
 * The recency factor of one record: 2^(-age / halfLife), clamped to (0, 1].
 * A timestamp in the future is age 0 (factor 1), never a boost.
 * @param {object} record
 * @param {{ halfLifeDays: number, asOf: number }} resolved
 * @returns {number|null} the factor, or null when the record has no usable time
 */
function recencyFactor(record, resolved) {
  const raw = record.createdAt;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const created = Date.parse(raw);
  if (!Number.isFinite(created)) return null;
  const age = Math.max(0, resolved.asOf - created);
  return round(Math.pow(2, -(age / (resolved.halfLifeDays * DAY_MS))));
}

/**
 * Rank records newest-first by their half-life decay. Records with an
 * unresolved timestamp sort after every scored record and keep the memoryId
 * tie-break, so the order is total and stable.
 * @param {object[]} records - already filtered; read-only
 * @param {{ halfLifeDays: number, asOf: number }} resolved
 * @returns {{ record: object, recency: number|null }[]} best first
 */
function rankByRecency(records, resolved) {
  return records
    .map((record) => ({ record, recency: recencyFactor(record, resolved) }))
    .sort((a, b) => {
      const left = a.recency === null ? -1 : a.recency;
      const right = b.recency === null ? -1 : b.recency;
      return (right - left) || a.record.memoryId.localeCompare(b.record.memoryId);
    });
}

module.exports = {
  DEFAULT_HALF_LIFE_DAYS,
  normalizeRecencyOptions,
  rankByRecency,
  recencyFactor,
};
