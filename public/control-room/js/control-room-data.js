'use strict';

/**
 * Control Room data layer: every function here reads or writes a real HUQAN
 * HTTP endpoint. Nothing in this file invents a number -- if an endpoint
 * fails or is unavailable, callers get `ok:false` and must say so honestly
 * in the UI rather than paper over it with a guess.
 */
(function (global) {
  const workspace = () => (sessionStorage.getItem('huqan-workspace') || 'default').trim() || 'default';
  const apiKey = () => sessionStorage.getItem('huqan-api-key') || '';
  const hasKey = () => Boolean(apiKey());

  // HUQAN's own failures (network, 5xx, refused auth) are kept here, apart
  // from agent decisions, and shown in the Errors view. Bounded: the newest
  // MAX_SYSTEM_ERRORS only, for this page load.
  const MAX_SYSTEM_ERRORS = 50;
  let systemErrors = [];
  function recordSystemError(path, status, error) {
    const entry = {
      at: new Date().toISOString(),
      path: String(path).split('?')[0],
      status: status || null,
      code: (error && error.code) || (status ? `HTTP_${status}` : 'NETWORK_ERROR'),
      message: (error && error.message) || '',
    };
    systemErrors = [entry, ...systemErrors].slice(0, MAX_SYSTEM_ERRORS);
    global.dispatchEvent(new CustomEvent('huqan:system-error', { detail: entry }));
  }

  // A request only counts as a system error when HUQAN itself failed: no
  // answer, a server error, or refused credentials. A 4xx about the request
  // (bad filter, unknown receipt) is the caller's to explain.
  function isSystemFailure(status) {
    return !status || status >= 500 || status === 401;
  }

  function failure(path, status, body) {
    const error = body.error || { code: `HTTP_${status}`, message: `HTTP ${status}` };
    if (isSystemFailure(status)) recordSystemError(path, status, error);
    if (status === 401) global.dispatchEvent(new CustomEvent('huqan:auth-required'));
    return { ok: false, status, error };
  }

  // GET /health is public and says whether this server wants an API key at
  // all. The key form is shown only when it does.
  async function fetchHealth() {
    let response;
    try {
      response = await fetch('/health', { cache: 'no-store' });
    } catch (error) {
      recordSystemError('/health', null, { code: 'NETWORK_ERROR', message: error.message });
      return { ok: false };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) {
      recordSystemError('/health', response.status, body.error);
      return { ok: false };
    }
    return { ok: true, apiAuthRequired: body.apiAuthRequired === true };
  }

  function authHeaders(extra) {
    const key = apiKey();
    return Object.assign({}, extra || {}, key ? { Authorization: `Bearer ${key}` } : {});
  }

  function withWorkspace(path) {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}workspaceId=${encodeURIComponent(workspace())}`;
  }

  async function getJson(path) {
    let response;
    try {
      response = await fetch(withWorkspace(path), { headers: authHeaders(), cache: 'no-store' });
    } catch (error) {
      const networkError = { code: 'NETWORK_ERROR', message: error.message };
      recordSystemError(path, null, networkError);
      return { ok: false, error: networkError };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) return failure(path, response.status, body);
    return { ok: true, body };
  }

  async function postJson(path, payload) {
    let response;
    try {
      // The approval-decision route reads workspaceId from the query string
      // via readExactWorkspace() and explicitly rejects it in the JSON body
      // ("body.workspaceId is not allowed") -- confirmed against the real
      // route while building this client. So workspaceId goes on the query
      // string only; the body carries exactly what the caller passed.
      response = await fetch(withWorkspace(path), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload || {}),
      });
    } catch (error) {
      const networkError = { code: 'NETWORK_ERROR', message: error.message };
      recordSystemError(path, null, networkError);
      return { ok: false, error: networkError };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) return failure(path, response.status, body);
    return { ok: true, body };
  }

  // ---- gate decisions (observability events, eventType=gate_decision) ----
  // Bounded pagination: never claims full history. `PAGE_CAP` is the most
  // pages fetched for one aggregation pass; if the window holds more, the
  // result says so via `truncated` instead of silently dropping events.
  const PAGE_CAP = 10; // 10 x 100 = up to 1000 events per window

  async function fetchGateDecisions({ windowMs }) {
    const items = [];
    let cursor;
    let truncated = false;
    for (let page = 0; page < PAGE_CAP; page += 1) {
      const params = new URLSearchParams({ eventType: 'gate_decision', limit: '100' });
      if (windowMs) params.set('windowMs', String(windowMs));
      if (cursor) params.set('cursor', cursor);
      const result = await getJson(`/api/observability/events?${params.toString()}`);
      if (!result.ok) return { ok: false, error: result.error };
      const data = result.body.data || {};
      items.push(...(data.items || []));
      if (!data.hasMore || !data.nextCursor) { cursor = null; break; }
      cursor = data.nextCursor;
      if (page === PAGE_CAP - 1) truncated = true;
    }
    return { ok: true, items, truncated };
  }

  // ---- approval queue ----
  async function fetchOpenApprovals() {
    const result = await getJson('/api/v2/approvals');
    if (!result.ok) return result;
    const data = result.body.data || {};
    return { ok: true, approvals: data.approvals || [], total: data.total || 0 };
  }

  async function decideApproval(approvalId, decision, reason) {
    const result = await postJson(`/api/v2/approvals/${encodeURIComponent(approvalId)}/decision`, { decision, reason: reason || '' });
    if (!result.ok) return result;
    return { ok: true, data: result.body.data || {} };
  }

  // ---- activity feed ----
  async function fetchActivity({ limit, cursor, eventType, actor } = {}) {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    if (eventType) params.set('eventType', eventType);
    if (actor) params.set('actor', actor);
    const qs = params.toString();
    const result = await getJson(`/api/workbench/activity${qs ? `?${qs}` : ''}`);
    if (!result.ok) return result;
    return { ok: true, items: result.body.items || [], hasMore: result.body.hasMore, nextCursor: result.body.nextCursor };
  }

  // ---- emergency-stop integrity (#2591) ----
  // Operator-only read: the route requires a scoped, single-use operator
  // capability (x-huqan-operator-capability). Without one the call 403s (or
  // 404s when no operator token is configured) and callers must treat the
  // state as unknown -- never as clean. No polling: a capability is spent
  // on first use, so every check is one explicit call.
  async function fetchEmergencyStopState({ agentId, operatorCapability } = {}) {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', String(agentId));
    const qs = params.toString();
    const extra = operatorCapability ? { 'x-huqan-operator-capability': String(operatorCapability) } : {};
    let response;
    try {
      response = await fetch(withWorkspace(`/api/v2/emergency-stops${qs ? `?${qs}` : ''}`), { headers: authHeaders(extra), cache: 'no-store' });
    } catch (error) {
      return { ok: false, error: { code: 'NETWORK_ERROR', message: error.message } };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      return {
        ok: false,
        status: response.status,
        error: body.error || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` },
      };
    }
    return { ok: true, state: (body.data || {}) };
  }

  // ---- receipts ----
  async function fetchReceipt(receiptId) {
    const result = await getJson(`/api/v2/trust-receipts/${encodeURIComponent(receiptId)}`);
    if (!result.ok) return result;
    const data = result.body.data || {};
    return { ok: true, receipt: data.receipt || null };
  }

  global.HuqanControlRoomData = {
    workspace,
    hasKey,
    fetchHealth,
    systemErrors: () => systemErrors.slice(),
    setSession(key, ws) {
      if (key !== undefined) sessionStorage.setItem('huqan-api-key', key || '');
      if (ws !== undefined) sessionStorage.setItem('huqan-workspace', ws || 'default');
    },
    clearSession() {
      sessionStorage.removeItem('huqan-api-key');
      sessionStorage.removeItem('huqan-workspace');
    },
    fetchGateDecisions,
    fetchEmergencyStopState,
    fetchOpenApprovals,
    decideApproval,
    fetchActivity,
    fetchReceipt,
    getJson,
    postJson,
  };
})(window);
