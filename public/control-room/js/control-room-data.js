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
  // from agent decisions, and shown in the Errors view. One row per failing
  // code and endpoint: a poll that keeps failing raises the row's count
  // instead of filling the list with copies. Bounded to MAX_SYSTEM_ERRORS
  // distinct rows for this page load.
  const MAX_SYSTEM_ERRORS = 50;
  let systemErrors = [];
  function recordSystemError(path, status, error) {
    const now = new Date().toISOString();
    const entry = {
      path: String(path).split('?')[0],
      status: status || null,
      code: (error && error.code) || (status ? `HTTP_${status}` : 'NETWORK_ERROR'),
      message: (error && error.message) || '',
    };
    const key = `${entry.code} ${entry.path}`;
    const previous = systemErrors.find((e) => e.key === key);
    const merged = {
      ...entry,
      key,
      at: now,
      firstAt: previous ? previous.firstAt : now,
      count: previous ? previous.count + 1 : 1,
    };
    systemErrors = [merged, ...systemErrors.filter((e) => e.key !== key)].slice(0, MAX_SYSTEM_ERRORS);
    global.dispatchEvent(new CustomEvent('huqan:system-error', { detail: merged }));
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
    authRequired = body.apiAuthRequired === true;
    return { ok: true, apiAuthRequired: authRequired };
  }

  // Whether this server asks for an API key; null until /health answered.
  let authRequired = null;

  // GET /v2-status is public and says, as one boolean, whether this
  // deployment configured the observability authorization policy. Without
  // it every observability read answers 503 by design, so the views ask once
  // and explain the missing setup instead of reporting a failure.
  let statusPromise = null;
  function fetchSetupStatus() {
    if (!statusPromise) {
      statusPromise = fetch('/v2-status', { cache: 'no-store' })
        .then((r) => r.json().catch(() => ({})))
        .then((body) => ({ ok: true, observabilityConfigured: body?.observability?.configured !== false }))
        .catch(() => ({ ok: false, observabilityConfigured: true }));
    }
    return statusPromise;
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

  async function postJson(path, payload, extraHeaders) {
    let response;
    try {
      // The approval-decision route reads workspaceId from the query string
      // via readExactWorkspace() and explicitly rejects it in the JSON body
      // ("body.workspaceId is not allowed") -- confirmed against the real
      // route while building this client. So workspaceId goes on the query
      // string only; the body carries exactly what the caller passed.
      response = await fetch(withWorkspace(path), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json', ...(extraHeaders || {}) }),
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
    const setup = await fetchSetupStatus();
    if (!setup.observabilityConfigured) {
      return { ok: false, unconfigured: true, error: { code: 'OBSERVABILITY_NOT_CONFIGURED', message: 'Activity counts are not set up on this server.' } };
    }
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
  // One record of what is waiting on a person. The sidebar badge, the
  // Overview's "Waiting for review" bucket, its "Waiting on you" panel and the
  // Approvals view all read this list, so they cannot disagree.
  let queue = { loaded: false, ok: false, approvals: [] };
  function publishQueue(next) {
    queue = next;
    global.dispatchEvent(new CustomEvent('huqan:approvals-changed', { detail: queue }));
    return queue;
  }
  async function fetchOpenApprovals() {
    const result = await getJson('/api/v2/approvals');
    if (!result.ok) {
      publishQueue({ loaded: true, ok: false, approvals: queue.approvals });
      return result;
    }
    const data = result.body.data || {};
    publishQueue({ loaded: true, ok: true, approvals: data.approvals || [] });
    return { ok: true, approvals: queue.approvals, total: queue.approvals.length };
  }
  function removeFromQueue(approvalId) {
    publishQueue({ ...queue, approvals: queue.approvals.filter((a) => a.id !== approvalId) });
  }

  // ---- operator grant (approve / reject) ----
  // A decision needs a one-use operator capability bound to exactly this
  // approval, verdict and reason. The server mints it either because the
  // person proved operator authority just now (operatorKey, never stored), or
  // because automatic approval is switched on for this computer.
  async function fetchGrant() {
    const result = await getJson('/api/v2/operator/grant');
    if (!result.ok) return { ok: false, available: result.status !== 404, error: result.error };
    return { ok: true, available: true, ...(result.body.data || {}) };
  }

  async function setGrantMode(mode, operatorKey) {
    let response;
    try {
      response = await fetch(withWorkspace('/api/v2/operator/grant'), {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(operatorKey ? { mode, operatorToken: operatorKey } : { mode }),
      });
    } catch (error) {
      return { ok: false, error: { code: 'NETWORK_ERROR', message: error.message } };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) return failure('/api/v2/operator/grant', response.status, body);
    global.dispatchEvent(new CustomEvent('huqan:grant-changed', { detail: body.data || {} }));
    return { ok: true, ...(body.data || {}) };
  }

  async function decideApproval(approvalId, decision, reason, { operatorKey } = {}) {
    const grantBody = { approvalId, decision, reason: reason || '' };
    if (operatorKey) grantBody.operatorToken = operatorKey;
    const grant = await postJson('/api/v2/operator/capabilities', grantBody);
    if (!grant.ok) {
      if (grant.status === 404 && grant.error?.code !== 'APPROVAL_NOT_FOUND') {
        return { ok: false, error: { code: 'OPERATOR_GRANT_UNAVAILABLE', message: 'Approvals from this screen are not set up on this server yet.' } };
      }
      return { ...grant, needsOperator: grant.status === 403 && !operatorKey };
    }
    const capability = grant.body.data && grant.body.data.capability;
    const result = await postJson(
      `/api/v2/approvals/${encodeURIComponent(approvalId)}/decision`,
      { decision, reason: reason || '' },
      { 'x-huqan-operator-capability': String(capability || '') },
    );
    if (!result.ok) return result;
    removeFromQueue(approvalId);
    return { ok: true, data: result.body.data || {}, grantedBy: grant.body.data.grantedBy };
  }

  // ---- agent registry ----
  // Registered agents with connected / disconnected / not connected, and what
  // discovery found on this computer. Adding or removing an agent changes
  // HUQAN's own registry only, never the agent's configuration.
  async function fetchAgents() {
    const result = await getJson('/api/v2/agents');
    return result.ok ? { ok: true, ...(result.body.data || {}) } : result;
  }
  async function discoverAgents() {
    const result = await getJson('/api/v2/agents/discovery');
    return result.ok ? { ok: true, agents: (result.body.data || {}).agents || [] } : result;
  }
  async function sendAgentChange(method, path, payload) {
    let response;
    try {
      response = await fetch(withWorkspace(path), {
        method,
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: payload ? JSON.stringify(payload) : undefined,
      });
    } catch (error) {
      return { ok: false, error: { code: 'NETWORK_ERROR', message: error.message } };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) return failure(path, response.status, body);
    return { ok: true, ...(body.data || {}) };
  }
  const registerAgent = (id) => sendAgentChange('POST', '/api/v2/agents', { id });
  const removeAgent = (id) => sendAgentChange('DELETE', `/api/v2/agents/${encodeURIComponent(id)}`);

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
    authRequired: () => authRequired,
    fetchHealth,
    fetchSetupStatus,
    approvalQueue: () => queue,
    fetchGrant,
    setGrantMode,
    fetchAgents,
    discoverAgents,
    registerAgent,
    removeAgent,
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
