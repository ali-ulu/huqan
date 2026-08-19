'use strict';

const { ACTIVITY_FILTERS, queryAgentActivity } = require('./activity-read');
const { readExactWorkspace } = require('../http/exact-workspace');

const ACTIVITY_PATH = '/api/workbench/activity';
const ACTIVITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function parseWorkbenchActivityPath(pathname) {
  if (pathname === ACTIVITY_PATH || pathname === `${ACTIVITY_PATH}/`) {
    return { ok: true };
  }
  return null;
}

function readSingleQuery(searchParams, key) {
  const values = searchParams.getAll(key);
  if (values.length > 1) return { ok: false, code: `invalid_${key}` };
  return { ok: true, value: values.length === 1 ? values[0] : '' };
}

function readActivityOptions(searchParams) {
  const options = {};
  for (const key of [...ACTIVITY_FILTERS, 'cursor', 'order', 'limit']) {
    const result = readSingleQuery(searchParams, key);
    if (!result.ok) return result;
    options[key] = result.value;
  }

  if (options.order && options.order !== 'asc' && options.order !== 'desc') {
    return { ok: false, code: 'invalid_order' };
  }
  if (options.limit && (!/^\d+$/.test(options.limit) || Number(options.limit) <= 0)) {
    return { ok: false, code: 'invalid_limit' };
  }
  return { ok: true, options };
}

function invalidActivityRequest(writeJson, req, res, code) {
  writeJson(req, res, 400, {
    ok: false,
    status: 'invalid_request',
    error: { code },
  }, ACTIVITY_HEADERS);
}

function handleWorkbenchActivityRequest({
  workspaceId,
  query,
  source,
}) {
  return queryAgentActivity(source, { ...query, workspaceId });
}

function createWorkbenchActivityRoute(options = {}) {
  const writeJson = options.writeJson;
  const denyIfUnauthorized = options.denyIfUnauthorized;
  if (typeof writeJson !== 'function') throw new TypeError('writeJson must be a function');
  if (typeof denyIfUnauthorized !== 'function') throw new TypeError('denyIfUnauthorized must be a function');

  return function handleWorkbenchActivity(req, res, reqUrl, graph) {
    const request = parseWorkbenchActivityPath(reqUrl?.pathname);
    if (!request) return false;

    if (req.method !== 'GET') {
      writeJson(req, res, 405, {
        ok: false,
        status: 'method_not_allowed',
        error: { code: 'method_not_allowed', message: 'Method not allowed' },
      }, ACTIVITY_HEADERS);
      return true;
    }
    if (!denyIfUnauthorized(req, res, ACTIVITY_HEADERS)) return true;

    const workspace = readExactWorkspace(reqUrl?.searchParams);
    if (!workspace.ok) {
      invalidActivityRequest(writeJson, req, res, workspace.code);
      return true;
    }

    const query = readActivityOptions(reqUrl.searchParams);
    if (!query.ok) {
      invalidActivityRequest(writeJson, req, res, query.code);
      return true;
    }

    const result = handleWorkbenchActivityRequest({
      workspaceId: workspace.workspaceId,
      query: query.options,
      source: graph,
    });
    const statusCode = result.ok ? 200 : 503;
    writeJson(req, res, statusCode, result, ACTIVITY_HEADERS);
    return true;
  };
}

module.exports = {
  ACTIVITY_HEADERS,
  ACTIVITY_PATH,
  createWorkbenchActivityRoute,
  handleWorkbenchActivityRequest,
  parseWorkbenchActivityPath,
  readActivityOptions,
};
