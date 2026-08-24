'use strict';

const { readExactWorkspace } = require('../http/exact-workspace');

const PREFIX = '/api/observability';
const NO_STORE = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const STREAM_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
});

function send(writeJson, req, res, status, body) {
  writeJson(req, res, status, body, NO_STORE);
}

function failure(writeJson, req, res, status, code, message) {
  send(writeJson, req, res, status, { ok: false, error: { code, message } });
}

function queryOptions(reqUrl) {
  return {
    limit: reqUrl.searchParams.get('limit') || undefined,
    cursor: reqUrl.searchParams.get('cursor') || undefined,
    eventType: reqUrl.searchParams.get('eventType') || undefined,
    runId: reqUrl.searchParams.get('runId') || undefined,
    status: reqUrl.searchParams.get('status') || undefined,
  };
}

function exactBodyWorkspace(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Object.prototype.hasOwnProperty.call(body, 'workspaceId')) {
    return { ok: false, code: 'MISSING_WORKSPACE_ID' };
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!workspaceId || workspaceId !== body.workspaceId || workspaceId.length > 128 || /[\x00-\x1F\x7F]/.test(workspaceId)) {
    return { ok: false, code: 'INVALID_WORKSPACE_ID' };
  }
  return { ok: true, workspaceId };
}

function createObservabilityHttpRouter({ getService, parseJsonRequest, writeJson, denyIfUnauthorized, authorizeWorkspace }) {
  for (const dependency of [getService, parseJsonRequest, writeJson, denyIfUnauthorized, authorizeWorkspace]) {
    if (typeof dependency !== 'function') throw new TypeError('observability route dependencies are required');
  }

  function authorize(req, res, workspaceId, permission) {
    try {
      const decision = authorizeWorkspace({ principal: req.huqanAuth, workspaceId, permission });
      if (decision?.allowed === true) return true;
      failure(writeJson, req, res, 403, decision?.code || 'OBSERVABILITY_WORKSPACE_FORBIDDEN', 'Observability access is forbidden.');
    } catch (_) {
      failure(writeJson, req, res, 503, 'OBSERVABILITY_AUTHORIZATION_UNAVAILABLE', 'Observability authorization is unavailable.');
    }
    return false;
  }

  return async function handleObservabilityRoute(req, res, reqUrl) {
    if (!reqUrl.pathname.startsWith(PREFIX)) return false;
    const suffix = reqUrl.pathname.slice(PREFIX.length).replace(/\/$/, '') || '/';
    if (suffix === '/stream') {
      if (req.method !== 'GET') {
        failure(writeJson, req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      if (!denyIfUnauthorized(req, res, NO_STORE)) return true;
      const workspace = readExactWorkspace(reqUrl.searchParams);
      if (!workspace.ok) {
        failure(writeJson, req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
        return true;
      }
      if (!authorize(req, res, workspace.workspaceId, 'stream')) return true;
      try {
        const service = getService();
        res.writeHead(200, STREAM_HEADERS);
        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, workspaceId: workspace.workspaceId })}\n\n`);
        const unsubscribe = service.subscribe(event => {
          if (event.workspaceId !== workspace.workspaceId || res.writableEnded) return;
          res.write(`event: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const keepAlive = setInterval(() => {
          if (!res.writableEnded) res.write(': keep-alive\n\n');
        }, 25_000);
        keepAlive.unref?.();
        const close = () => {
          clearInterval(keepAlive);
          unsubscribe();
        };
        req.once('close', close);
        res.once('close', close);
      } catch (error) {
        if (!res.headersSent) failure(writeJson, req, res, 503, error.code || 'OBSERVABILITY_UNAVAILABLE', 'Observability service is unavailable.');
      }
      return true;
    }

    if (!['/metrics', '/events', '/runs', '/queue', '/alerts', '/alert-rules'].includes(suffix)
        && !/^\/alert-rules\/[^/]+$/.test(suffix)) return false;
    if (!denyIfUnauthorized(req, res, NO_STORE)) return true;

    // DELETE reads its scope from the query string exactly as the GET surfaces
    // do, so it goes through the same validation. Without it a request that
    // names no workspace was rejected on GET but accepted on DELETE, where
    // normalizeWorkspaceId silently resolved the missing value to `default`
    // and removed a rule the caller never scoped.
    const requiresWorkspaceQuery = req.method === 'GET' || req.method === 'DELETE';
    let workspaceId = '';
    if (requiresWorkspaceQuery) {
      const workspace = readExactWorkspace(reqUrl.searchParams);
      if (!workspace.ok) {
        failure(writeJson, req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
        return true;
      }
      workspaceId = workspace.workspaceId;
      const permission = req.method === 'DELETE' ? 'alerts:write' : 'read';
      if (!authorize(req, res, workspaceId, permission)) return true;
    }

    try {
      let body = null;
      if (req.method === 'POST' && suffix === '/queue') {
        body = await parseJsonRequest(req, res, { maxBytes: 12_288 });
        if (!body) return true;
        const workspace = exactBodyWorkspace(body);
        if (!workspace.ok) {
          failure(writeJson, req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
          return true;
        }
        workspaceId = workspace.workspaceId;
        if (!authorize(req, res, workspaceId, 'queue:write')) return true;
      } else if (req.method === 'POST' && suffix === '/alert-rules') {
        body = await parseJsonRequest(req, res, { maxBytes: 4_096 });
        if (!body) return true;
        const workspace = exactBodyWorkspace(body);
        if (!workspace.ok) {
          failure(writeJson, req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
          return true;
        }
        workspaceId = workspace.workspaceId;
        if (!authorize(req, res, workspaceId, 'alerts:write')) return true;
      }
      const service = getService();
      if (req.method === 'GET' && suffix === '/metrics') {
        send(writeJson, req, res, 200, { ok: true, data: { metrics: service.summary({ workspaceId, windowMs: reqUrl.searchParams.get('windowMs') }), queue: service.queueSummary({ workspaceId }), alerts: service.listAlerts({ workspaceId, limit: 20 }) } });
        return true;
      }
      if (req.method === 'GET' && suffix === '/events') {
        send(writeJson, req, res, 200, { ok: true, data: service.listEvents({ workspaceId, ...queryOptions(reqUrl) }) });
        return true;
      }
      if (req.method === 'GET' && suffix === '/runs') {
        send(writeJson, req, res, 200, { ok: true, data: service.listRuns({ workspaceId, ...queryOptions(reqUrl) }) });
        return true;
      }
      if (req.method === 'GET' && suffix === '/queue') {
        send(writeJson, req, res, 200, { ok: true, data: { ...service.queueSummary({ workspaceId }), items: service.listQueue({ workspaceId, limit: reqUrl.searchParams.get('limit') }) } });
        return true;
      }
      if (req.method === 'GET' && suffix === '/alerts') {
        send(writeJson, req, res, 200, { ok: true, data: { items: service.listAlerts({ workspaceId, limit: reqUrl.searchParams.get('limit') }) } });
        return true;
      }
      if (req.method === 'GET' && suffix === '/alert-rules') {
        send(writeJson, req, res, 200, { ok: true, data: { items: service.listAlertRules({ workspaceId, limit: reqUrl.searchParams.get('limit') }) } });
        return true;
      }
      if (req.method === 'POST' && suffix === '/queue') {
        const job = service.enqueueJob(body);
        send(writeJson, req, res, 202, { ok: true, data: job });
        return true;
      }
      if (req.method === 'POST' && suffix === '/alert-rules') {
        const rule = service.createAlertRule(body);
        send(writeJson, req, res, 201, { ok: true, data: rule });
        return true;
      }
      const ruleMatch = suffix.match(/^\/alert-rules\/([^/]+)$/);
      if (ruleMatch && req.method === 'DELETE') {
        const deleted = service.deleteAlertRule({ workspaceId, ruleId: decodeURIComponent(ruleMatch[1]) });
        send(writeJson, req, res, deleted ? 200 : 404, { ok: deleted, data: { deleted } });
        return true;
      }
      failure(writeJson, req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    } catch (error) {
      const status = /^INVALID_|^OBSERVABILITY_/.test(error.code || '') ? 400 : 503;
      failure(writeJson, req, res, status, error.code || 'OBSERVABILITY_FAILED', error.message || 'Observability request failed.');
    }
    return true;
  };
}

module.exports = { createObservabilityHttpRouter, NO_STORE, PREFIX, STREAM_HEADERS };
