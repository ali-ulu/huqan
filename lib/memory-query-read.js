'use strict';

/**
 * Memory record search for agents and operators: the one projection behind
 * `huqan.memory_query` (MCP), `memory-query` (CLI) and
 * `GET /api/memory/query` (HTTP), so the three surfaces cannot drift.
 *
 * Read-only. It drives MemoryStore.query, which owns the workspace boundary,
 * the active-status filter and the ranking; this module only validates the
 * request and shapes the answer. Two defaults differ from the store API on
 * purpose, because these surfaces feed context windows:
 *
 *   - retrievalMode defaults to `bm25` (#3462: recall@10 0.842 vs 0.037 for
 *     whole-query substring on 409 real issue-title queries). `substring`
 *     stays available. The store API itself keeps substring as its default.
 *   - the recall gate is always on: unprovenanced or inactive records are
 *     withheld, and degraded ones come back marked rather than dropped.
 */

const MEMORY_QUERY_MODES = Object.freeze(['bm25', 'substring', 'recency']);
const MEMORY_QUERY_LIMITS = Object.freeze({ textMax: 500, workspaceMax: 128, defaultLimit: 10, maxLimit: 100 });

function invalid(message) {
  return { ok: false, code: 'invalid_request', message };
}

// Only an absent value takes the default. An explicitly empty one (`limit=`
// on a query string) is a malformed request, refused like any other.
function readInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isSafeInteger(number) ? number : NaN;
}

function readBoolean(value) {
  if (value === undefined || value === null) return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

// halfLifeDays may arrive as a number (MCP) or a numeric string (query string,
// argv). An absent value is undefined so the leaf's own default applies; a
// present but non-numeric one is NaN, refused by the caller.
function readNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : NaN;
}

/**
 * Validate a request from any surface. Strings from a query string or argv
 * and typed values from MCP are both accepted for limit/offset/explain.
 */
function normalizeMemoryQueryInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const retrievalMode = source.retrievalMode === undefined || source.retrievalMode === null ? 'bm25' : source.retrievalMode;
  if (!MEMORY_QUERY_MODES.includes(retrievalMode)) return invalid(`retrievalMode must be one of: ${MEMORY_QUERY_MODES.join(', ')}`);
  const text = typeof source.text === 'string' ? source.text.trim() : '';
  if (text.length > MEMORY_QUERY_LIMITS.textMax) return invalid(`text exceeds ${MEMORY_QUERY_LIMITS.textMax} characters`);
  // Every mode but recency ranks a text query; recency is a pure time ordering.
  if (!text && retrievalMode !== 'recency') return invalid('text is required');
  const workspaceId = typeof source.workspaceId === 'string' ? source.workspaceId.trim() : '';
  if (!workspaceId) return invalid('workspaceId is required');
  if (workspaceId.length > MEMORY_QUERY_LIMITS.workspaceMax) return invalid('workspaceId is too long');
  const limit = readInteger(source.limit, MEMORY_QUERY_LIMITS.defaultLimit);
  if (!(limit >= 1 && limit <= MEMORY_QUERY_LIMITS.maxLimit)) return invalid(`limit must be an integer from 1 to ${MEMORY_QUERY_LIMITS.maxLimit}`);
  const offset = readInteger(source.offset, 0);
  if (!(offset >= 0)) return invalid('offset must be a non-negative integer');
  const explain = readBoolean(source.explain);
  if (explain === null) return invalid('explain must be a boolean');
  if (explain && retrievalMode !== 'bm25') return invalid('explain requires retrievalMode bm25');
  // Opt-in `storeTotal`: ask the store for its unfiltered count so a caller can
  // tell an empty store apart from a text that matched nothing (#3640). Off by
  // default, so the projection's shape is unchanged for every other caller.
  const storeTotal = readBoolean(source.storeTotal);
  if (storeTotal === null) return invalid('storeTotal must be a boolean');

  const recencySource = source.recency && typeof source.recency === 'object' && !Array.isArray(source.recency) ? source.recency : {};
  const halfLifeDays = readNumber(source.halfLifeDays !== undefined ? source.halfLifeDays : recencySource.halfLifeDays);
  if (Number.isNaN(halfLifeDays)) return invalid('halfLifeDays must be a number');
  const asOfRaw = source.asOf !== undefined ? source.asOf : recencySource.asOf;
  const asOf = typeof asOfRaw === 'string' ? asOfRaw.trim() : asOfRaw;
  if (asOf !== undefined && asOf !== null && typeof asOf !== 'string') return invalid('asOf must be an ISO timestamp');
  // Recency options on a text ranking would be a silent no-op; refuse them.
  if (retrievalMode !== 'recency' && (source.recency !== undefined || halfLifeDays !== undefined || asOf !== undefined)) {
    return invalid('recency options require retrievalMode recency');
  }
  return { ok: true, text, workspaceId, retrievalMode, limit, offset, explain, storeTotal, halfLifeDays, asOf };
}

function projectRecord(record, score, recallDecision, recency) {
  const provenance = record.provenance || {};
  const item = {
    memoryId: record.memoryId,
    kind: record.kind || 'memory-record',
    content: record.content,
    createdAt: record.createdAt || null,
    source: { sourceRef: provenance.sourceRef || null, sourceType: provenance.sourceType || null, actor: provenance.actor || null },
    // The gate decides every record it is handed, so a missing decision is a
    // broken invariant, reported as such rather than as an admit.
    recall: recallDecision ? { decision: recallDecision.decision, reason: recallDecision.reason } : { decision: 'unknown', reason: 'no_recall_decision' },
  };
  if (score) {
    item.score = score.score;
    if (score.terms) item.terms = score.terms;
  }
  if (recency) item.recency = recency.recency;
  return item;
}

/**
 * @param {object|null} memory - a MemoryStore (kernel.memory)
 * @param {object} input - { text, workspaceId, retrievalMode?, limit?, offset?, explain? }
 * @returns {{ ok: true, workspaceId, text, retrievalMode, total, limit, offset, items, recall }
 *   | { ok: false, code: 'invalid_request'|'memory_unavailable'|'query_rejected', message }}
 */
function buildMemoryQueryRead(memory, input) {
  const request = normalizeMemoryQueryInput(input);
  if (!request.ok) return request;
  if (!memory || typeof memory.query !== 'function') {
    return { ok: false, code: 'memory_unavailable', message: 'no memory store is available' };
  }
  const result = memory.query({
    workspaceId: request.workspaceId,
    text: request.text,
    limit: request.limit,
    offset: request.offset,
    recall: true,
    ...(request.storeTotal ? { storeTotal: true } : {}),
    ...(request.retrievalMode === 'bm25' ? { retrievalMode: 'bm25', explain: request.explain } : {}),
    ...(request.retrievalMode === 'recency' ? {
      retrievalMode: 'recency',
      recency: {
        ...(request.halfLifeDays !== undefined ? { halfLifeDays: request.halfLifeDays } : {}),
        ...(request.asOf !== undefined ? { asOf: request.asOf } : {}),
      },
    } : {}),
  });
  if (!result.ok) return { ok: false, code: 'query_rejected', message: result.error?.message || 'query rejected' };
  const scores = new Map((result.retrieval?.scores || []).map((entry) => [entry.memoryId, entry]));
  const recency = new Map((result.recency?.scores || []).map((entry) => [entry.memoryId, entry]));
  const decisions = new Map((result.recall?.decisions || []).map((entry) => [entry.memoryId, entry]));
  return {
    ok: true,
    workspaceId: request.workspaceId,
    text: request.text,
    retrievalMode: request.retrievalMode,
    total: result.total,
    limit: request.limit,
    offset: request.offset,
    items: result.memories.map((record) => projectRecord(record, scores.get(record.memoryId), decisions.get(record.memoryId), recency.get(record.memoryId))),
    recall: result.recall ? { ...result.recall.summary } : null,
    // Both come from the same read, so a caller that asked for storeTotal can
    // tell "this store is empty" from "this text matched nothing" without a
    // second, separately-failing read (#3640).
    ...(result.storeTotal === undefined ? {} : { storeTotal: result.storeTotal, storeEmpty: result.storeTotal === 0 }),
  };
}

module.exports = { MEMORY_QUERY_LIMITS, MEMORY_QUERY_MODES, buildMemoryQueryRead, normalizeMemoryQueryInput };
