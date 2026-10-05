'use strict';

/**
 * Memory query route.
 *
 *   GET /api/memory/query?workspaceId=<ws>&text=<query>[&retrievalMode=bm25|substring]
 *       [&limit=<1-100>][&offset=<n>][&explain=true]
 *
 * The shared projection from lib/memory-query-read.js served over HTTP,
 * mounted behind the authenticated routes like the Experience read route. The
 * workspace boundary inside the store query is a correctness boundary, not
 * an auth boundary. Returns true when the path belongs to this surface (even
 * on 4xx), false otherwise.
 */

const { buildMemoryQueryRead } = require('../memory-query-read');

const MEMORY_QUERY_PATH = '/api/memory/query';

const HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

const STATUS_BY_CODE = Object.freeze({ invalid_request: 400, query_rejected: 400, memory_unavailable: 503 });

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return undefined;
  // oxlint-disable-next-line no-control-regex -- deliberate: strips control characters from query input
  return value.slice(0, maxLen).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function handleMemoryQueryRequest({ req, res, reqUrl, memory, writeJson }) {
  const pathname = reqUrl && reqUrl.pathname;
  if (typeof pathname !== 'string' || pathname !== MEMORY_QUERY_PATH) return false;
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    writeJson(req, res, 405, { ok: false, code: 'method_not_allowed' }, HEADERS);
    return true;
  }
  const params = (reqUrl && reqUrl.searchParams) || new Map();
  const get = (key) => {
    const value = typeof params.get === 'function' ? params.get(key) : params[key];
    return value === null ? undefined : value;
  };
  // One past the projection's limits, so an over-long value is refused there
  // instead of being silently truncated into a different query here.
  const result = buildMemoryQueryRead(memory, {
    text: sanitize(get('text'), 501),
    workspaceId: sanitize(get('workspaceId'), 129),
    retrievalMode: sanitize(get('retrievalMode'), 16),
    limit: sanitize(get('limit'), 8),
    offset: sanitize(get('offset'), 12),
    explain: sanitize(get('explain'), 8),
  });
  writeJson(req, res, result.ok ? 200 : (STATUS_BY_CODE[result.code] || 500), result, HEADERS);
  return true;
}

module.exports = { MEMORY_QUERY_PATH, handleMemoryQueryRequest };
