'use strict';

/**
 * Experience read route (E6, #2400).
 *
 *   GET /api/experience/read?runId=<id>&workspaceId=<ws>   JSON projection
 *
 * The single shared projection from `lib/experience/read-model.js`,
 * served over HTTP. Mount behind the authenticated routes: the workspace
 * check inside the projection is a correctness boundary, not an auth
 * boundary. Handler shape mirrors handlePublicBadgeRequest — returns true
 * when the path belongs to this surface (even on 4xx), false otherwise.
 * The journal is passed in (`{ journal }`); server wiring lands with the
 * runtime seams (#2378).
 */

const { buildExperienceRead } = require('../experience/read-model');

const EXPERIENCE_READ_PREFIX = '/api/experience/read';

const HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  // oxlint-disable-next-line no-control-regex -- deliberate: strips control characters from query input
  return value.slice(0, maxLen).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function statusFor(code) {
  if (code === 'run_not_found') return 404;
  if (code === 'workspace_mismatch') return 403;
  return 502;
}

/**
 * Route handler. Returns true when the path belongs to this surface.
 */
function handleExperienceReadRequest({ req, res, reqUrl, journal, writeJson }) {
  const pathname = reqUrl && reqUrl.pathname;
  if (typeof pathname !== 'string' || pathname !== EXPERIENCE_READ_PREFIX) return false;
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    writeJson(req, res, 405, { ok: false, code: 'method_not_allowed' }, HEADERS);
    return true;
  }
  const params = (reqUrl && reqUrl.searchParams) || new Map();
  const get = (key) => (typeof params.get === 'function' ? params.get(key) : params[key]);
  const projection = buildExperienceRead(journal, {
    runId: sanitize(get('runId') || '', 128),
    workspaceId: sanitize(get('workspaceId') || '', 128),
  });
  if (!projection.ok) {
    const code = projection.code === 'invalid_request' ? 400 : statusFor(projection.code);
    writeJson(req, res, code, projection, HEADERS);
    return true;
  }
  writeJson(req, res, 200, projection, HEADERS);
  return true;
}

module.exports = { EXPERIENCE_READ_PREFIX, handleExperienceReadRequest };
