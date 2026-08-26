'use strict';

const { readExactWorkspace } = require('../http/exact-workspace');
const { createObservabilityRateLimiter } = require('./rate-limiter');
const {
  OBSERVABILITY_API_PREFIX,
  OBSERVABILITY_OPENAPI_PATH,
  observabilityOpenApiDocument,
} = require('./api-contract');

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
const RATE_LIMIT_HEADERS = Object.freeze({ ...NO_STORE });

function send(writeJson, req, res, status, body) {
  writeJson(req, res, status, body, NO_STORE);
}

function failure(writeJson, req, res, status, code, message) {
  send(writeJson, req, res, status, { ok: false, error: { code, message } });
}

const OBSERVABILITY_QUERY_FIELDS = new Set([
  'workspaceId', 'limit', 'cursor', 'eventType', 'runId', 'status', 'windowMs',
]);
const MAX_OBSERVABILITY_QUERY_LENGTH = 2_048;
const MAX_OBSERVABILITY_QUERY_PARAMETERS = 8;
const MAX_OBSERVABILITY_QUERY_VALUE_LENGTH = 128;
const MAX_OBSERVABILITY_CURSOR_LENGTH = 512;
const MAX_OBSERVABILITY_LIMIT = 100;

function isValidObservabilityQuery(reqUrl) {
  if (!reqUrl || typeof reqUrl.search !== 'string' || !reqUrl.searchParams) return false;
  if (reqUrl.search.length > MAX_OBSERVABILITY_QUERY_LENGTH) return false;
  const keys = [...reqUrl.searchParams.keys()];
  if (keys.length > MAX_OBSERVABILITY_QUERY_PARAMETERS) return false;
  for (const key of keys) {
    if (!OBSERVABILITY_QUERY_FIELDS.has(key)) return false;
    const values = reqUrl.searchParams.getAll(key);
    if (key === 'workspaceId') continue;
    if (values.length !== 1) return false;
    const maximum = key === 'cursor' ? MAX_OBSERVABILITY_CURSOR_LENGTH : MAX_OBSERVABILITY_QUERY_VALUE_LENGTH;
    if (values.some(value => value.length > maximum)) return false;
  }
  const limit = reqUrl.searchParams.get('limit');
  return limit === null || (/^[1-9]\d*$/.test(limit) && Number(limit) <= MAX_OBSERVABILITY_LIMIT);
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

function createObservabilityHttpRouter({
  getService,
  getHealth,
  parseJsonRequest,
  writeJson,
  denyIfUnauthorized,
  authorizeWorkspace,
  rateLimiter = createObservabilityRateLimiter(),
}) {
  for (const dependency of [getService, getHealth, parseJsonRequest, writeJson, denyIfUnauthorized, authorizeWorkspace]) {
    if (typeof dependency !== 'function') throw new TypeError('observability route dependencies are required');
  }
  if (!rateLimiter || typeof rateLimiter.acquire !== 'function') {
    throw new TypeError('observability rate limiter is required');
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

  function rateLimitKey(req, workspaceId, dimension) {
    const subject = typeof req.huqanAuth?.subject === 'string' && req.huqanAuth.subject.trim()
      ? req.huqanAuth.subject.trim()
      : 'anonymous';
    return `${dimension}:${dimension === 'subject' ? subject : workspaceId}`;
  }

  function rateLimit(req, res, bucket, workspaceId) {
    const subject = rateLimiter.acquire({ bucket, key: rateLimitKey(req, workspaceId, 'subject') });
    if (!subject.allowed) return subject;
    const workspace = rateLimiter.acquire({ bucket, key: rateLimitKey(req, workspaceId, 'workspace') });
    if (!workspace.allowed) {
      subject.cancel?.();
      return workspace;
    }
    let released = false;
    return {
      allowed: true,
      release() {
        if (released) return;
        released = true;
        workspace.release();
        subject.release();
      },
    };
  }

  function rateLimitFailure(req, res, decision) {
    writeJson(req, res, 429, {
      ok: false,
      error: { code: 'OBSERVABILITY_RATE_LIMITED', message: 'Observability request rate limit exceeded.' },
    }, { ...RATE_LIMIT_HEADERS, 'Retry-After': String(decision.retryAfterSeconds) });
  }

  return async function handleObservabilityRoute(req, res, reqUrl) {
    if (reqUrl.pathname === OBSERVABILITY_OPENAPI_PATH) {
      if (req.method !== 'GET') {
        failure(writeJson, req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      send(writeJson, req, res, 200, observabilityOpenApiDocument());
      return true;
    }
    const routePrefix = reqUrl.pathname.startsWith(`${OBSERVABILITY_API_PREFIX}/`)
      ? OBSERVABILITY_API_PREFIX
      : PREFIX;
    if (!reqUrl.pathname.startsWith(routePrefix)) return false;
    const suffix = reqUrl.pathname.slice(routePrefix.length).replace(/\/$/, '') || '/';
    if (suffix === '/stream') {
      if (req.method !== 'GET') {
        failure(writeJson, req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
      }
      if (!denyIfUnauthorized(req, res, NO_STORE, { errorCode: 'UNAUTHORIZED' })) return true;
      if (!isValidObservabilityQuery(reqUrl)) {
        failure(writeJson, req, res, 400, 'OBSERVABILITY_QUERY_INVALID', 'Observability query is invalid.');
        return true;
      }
      const workspace = readExactWorkspace(reqUrl.searchParams);
      if (!workspace.ok) {
        failure(writeJson, req, res, 400, workspace.code, 'Exactly one non-empty workspaceId is required.');
        return true;
      }
      if (!authorize(req, res, workspace.workspaceId, 'stream')) return true;
      const rate = rateLimit(req, res, 'stream', workspace.workspaceId);
      if (!rate.allowed) {
        rateLimitFailure(req, res, rate);
        return true;
      }
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
          rate.release();
        };
        req.once('close', close);
        res.once('close', close);
      } catch (error) {
        rate.release();
        if (!res.headersSent) failure(writeJson, req, res, 503, error.code || 'OBSERVABILITY_UNAVAILABLE', 'Observability service is unavailable.');
      }
      return true;
    }

    if (!['/health', '/ready', '/metrics', '/events', '/runs', '/queue', '/alerts', '/alert-rules'].includes(suffix)
        && !/^\/alert-rules\/[^/]+$/.test(suffix)) return false;
    if (!denyIfUnauthorized(req, res, NO_STORE, { errorCode: 'UNAUTHORIZED' })) return true;
    if (!isValidObservabilityQuery(reqUrl)) {
      failure(writeJson, req, res, 400, 'OBSERVABILITY_QUERY_INVALID', 'Observability query is invalid.');
      return true;
    }

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

    let rate = null;
    try {
      if (req.method === 'GET' && (suffix === '/health' || suffix === '/ready')) {
        const health = getHealth().inspect(workspaceId);
        const status = suffix === '/ready' && !health.readiness.ok ? 503 : 200;
        send(writeJson, req, res, status, { ok: suffix === '/health' ? health.liveness.ok : health.readiness.ok, data: health });
        return true;
      }

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
        rate = rateLimit(req, res, 'queue', workspaceId);
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
        rate = rateLimit(req, res, 'alerts', workspaceId);
      }
      if (requiresWorkspaceQuery && !rate) {
        const bucket = req.method === 'DELETE' ? 'alerts' : 'read';
        rate = rateLimit(req, res, bucket, workspaceId);
      }
      if (rate && !rate.allowed) {
        rateLimitFailure(req, res, rate);
        return true;
      }
      const service = getService();
      if (req.method === 'GET' && suffix === '/metrics') {
        send(writeJson, req, res, 200, { ok: true, data: { metrics: service.summary({ workspaceId, windowMs: reqUrl.searchParams.get('windowMs') }), queue: service.queueSummary({ workspaceId }), alerts: service.listAlerts({ workspaceId, limit: 20 }) } });
        return true;
      }
      if (req.method === 'GET' && suffix === '/events') {
        send(writeJson, req, res, 200, { ok: true, data: service.listEvents({ workspaceId, ...queryOptions(reqUrl), windowMs: reqUrl.searchParams.get('windowMs') || undefined }) });
        return true;
      }
      if (req.method === 'GET' && suffix === '/runs') {
        send(writeJson, req, res, 200, { ok: true, data: service.listRuns({ workspaceId, ...queryOptions(reqUrl), windowMs: reqUrl.searchParams.get('windowMs') || undefined }) });
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
    } finally {
      rate?.release();
    }
    return true;
  };
}

module.exports = { createObservabilityHttpRouter, NO_STORE, PREFIX, STREAM_HEADERS };
