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

const MEMORY_QUERY_MODES = Object.freeze(['bm25', 'substring']);
const MEMORY_QUERY_LIMITS = Object.freeze({ textMax: 500, workspaceMax: 128, defaultLimit: 10, maxLimit: 100 });

function invalid(message) {
  return { ok: false, code: 'invalid_request', message };
}

function readInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isSafeInteger(number) ? number : NaN;
}

function readBoolean(value) {
  if (value === undefined || value === null || value === '') return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

/**
 * Validate a request from any surface. Strings from a query string or argv
 * and typed values from MCP are both accepted for limit/offset/explain.
 */
function normalizeMemoryQueryInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const text = typeof source.text === 'string' ? source.text.trim() : '';
  if (!text) return invalid('text is required');
  if (text.length > MEMORY_QUERY_LIMITS.textMax) return invalid(`text exceeds ${MEMORY_QUERY_LIMITS.textMax} characters`);
  const workspaceId = typeof source.workspaceId === 'string' ? source.workspaceId.trim() : '';
  if (!workspaceId) return invalid('workspaceId is required');
  if (workspaceId.length > MEMORY_QUERY_LIMITS.workspaceMax) return invalid('workspaceId is too long');
  const retrievalMode = source.retrievalMode === undefined || source.retrievalMode === '' ? 'bm25' : source.retrievalMode;
  if (!MEMORY_QUERY_MODES.includes(retrievalMode)) return invalid(`retrievalMode must be one of: ${MEMORY_QUERY_MODES.join(', ')}`);
  const limit = readInteger(source.limit, MEMORY_QUERY_LIMITS.defaultLimit);
  if (!(limit >= 1 && limit <= MEMORY_QUERY_LIMITS.maxLimit)) return invalid(`limit must be an integer from 1 to ${MEMORY_QUERY_LIMITS.maxLimit}`);
  const offset = readInteger(source.offset, 0);
  if (!(offset >= 0)) return invalid('offset must be a non-negative integer');
  const explain = readBoolean(source.explain);
  if (explain === null) return invalid('explain must be a boolean');
  if (explain && retrievalMode !== 'bm25') return invalid('explain requires retrievalMode bm25');
  return { ok: true, text, workspaceId, retrievalMode, limit, offset, explain };
}

function projectRecord(record, score, recallDecision) {
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
    ...(request.retrievalMode === 'bm25' ? { retrievalMode: 'bm25', explain: request.explain } : {}),
  });
  if (!result.ok) return { ok: false, code: 'query_rejected', message: result.error?.message || 'query rejected' };
  const scores = new Map((result.retrieval?.scores || []).map((entry) => [entry.memoryId, entry]));
  const decisions = new Map((result.recall?.decisions || []).map((entry) => [entry.memoryId, entry]));
  return {
    ok: true,
    workspaceId: request.workspaceId,
    text: request.text,
    retrievalMode: request.retrievalMode,
    total: result.total,
    limit: request.limit,
    offset: request.offset,
    items: result.memories.map((record) => projectRecord(record, scores.get(record.memoryId), decisions.get(record.memoryId))),
    recall: result.recall ? { ...result.recall.summary } : null,
  };
}

module.exports = { MEMORY_QUERY_LIMITS, MEMORY_QUERY_MODES, buildMemoryQueryRead, normalizeMemoryQueryInput };
