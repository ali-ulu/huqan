(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const workspace = () => (byId('workspace')?.value || byId('ws')?.value || 'default').trim() || 'default';
  const headers = () => {
    const key = sessionStorage.getItem('huqan-api-key') || '';
    return key ? { Authorization: `Bearer ${key}` } : {};
  };
  const get = async (path) => {
    const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}workspaceId=${encodeURIComponent(workspace())}`, { headers: headers(), cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      // Keep the typed code, not only the prose (#1825). Readiness is decided
      // on OBSERVABILITY_AUTHORIZATION_UNAVAILABLE, and a message string is
      // free to be reworded without anyone noticing the gate broke.
      const error = new Error(body.error?.message || `HTTP ${response.status}`);
      error.code = body.error?.code || '';
      error.status = response.status;
      throw error;
    }
    return body.data || body;
  };
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ ...body, workspaceId: workspace() }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error?.message || `HTTP ${response.status}`);
    return data.data || data;
  };
  const escape = value => String(value ?? '—').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const formatDuration = value => value === null || value === undefined ? '—' : `${Math.round(value)} ms`;
  const formatTokens = value => value === null || value === undefined ? T('observability.notMeasured', 'not measured') : Number(value).toLocaleString(locale());
  const formatCount = value => Number(value).toLocaleString(locale());
  const setStatus = text => { if (byId('obsstatus')) byId('obsstatus').textContent = text; };
  const observabilityRuns = { items: [], nextCursor: null, hasMore: false };
  const observabilityEvents = { items: [], nextCursor: null, hasMore: false, eventType: '', runId: '' };
  const observabilityWindow = () => {
    const value = Number(byId('obswindow')?.value);
    return Number.isSafeInteger(value) && value >= 1000 ? value : 24 * 60 * 60 * 1000;
  };
  const observabilityWindowLabel = () => byId('obswindow')?.selectedOptions?.[0]?.textContent || T('observability.selectedWindow', 'selected window');
  const STREAM_BASE_RECONNECT_DELAY_MS = 1000;
  const STREAM_MAX_RECONNECT_DELAY_MS = 15000;
  const STREAM_MAX_SEEN_EVENTS = 128;
  const streamSeenEvents = { ids: new Set(), order: [] };
  function streamEventKey(event) {
    return String(event?.eventId || [event?.eventType, event?.createdAt, event?.runId, event?.traceId, event?.status, event?.tool].map(value => String(value ?? '')).join(':'));
  }
  function rememberStreamEvent(event) {
    const key = streamEventKey(event);
    if (streamSeenEvents.ids.has(key)) return false;
    streamSeenEvents.ids.add(key);
    streamSeenEvents.order.push(key);
    while (streamSeenEvents.order.length > STREAM_MAX_SEEN_EVENTS) streamSeenEvents.ids.delete(streamSeenEvents.order.shift());
    return true;
  }

  async function loadEventHistory(reset = true) {
    const cursor = reset ? '' : observabilityEvents.nextCursor;
    if (!reset && !cursor) return observabilityEvents;
    if (reset) {
      observabilityEvents.eventType = byId('obseventtype')?.value.trim() || '';
      observabilityEvents.runId = byId('obseventrun')?.value.trim() || '';
    }
    const query = new URLSearchParams({ limit: '20', windowMs: String(observabilityWindow()) });
    if (cursor) query.set('cursor', cursor);
    if (observabilityEvents.eventType) query.set('eventType', observabilityEvents.eventType);
    if (observabilityEvents.runId) query.set('runId', observabilityEvents.runId);
    byId('obseventstatus').textContent = reset ? T('observability.events.loading', 'Loading event history…') : T('observability.events.loadingNext', 'Loading next event page…');
    let page;
    try {
      page = await get(`/api/observability/events?${query.toString()}`);
    } catch (error) {
      byId('obseventstatus').textContent = T('observability.events.loadError', `Event history could not be loaded: ${error.message}`, { message: error.message });
      throw error;
    }
    observabilityEvents.items = reset ? (page.items || []) : [...observabilityEvents.items, ...(page.items || [])];
    observabilityEvents.nextCursor = page.nextCursor || null;
    observabilityEvents.hasMore = Boolean(page.hasMore && observabilityEvents.nextCursor);
    renderEventHistory({ ...page, items: observabilityEvents.items, hasMore: observabilityEvents.hasMore });
    const eventTypeSuffix = observabilityEvents.eventType ? ` · ${observabilityEvents.eventType}` : '';
    const runIdSuffix = observabilityEvents.runId ? ` · ${T('observability.events.runPrefix', 'run')} ${observabilityEvents.runId}` : '';
    byId('obseventstatus').textContent = T(
      'observability.events.summary',
      `Showing ${observabilityEvents.items.length} events · ${observabilityWindowLabel()}${eventTypeSuffix}${runIdSuffix}`,
      { count: observabilityEvents.items.length, window: observabilityWindowLabel(), eventType: eventTypeSuffix, runId: runIdSuffix },
    );
    return observabilityEvents;
  }
  async function loadRuns(reset = true) {
    const windowMs = observabilityWindow();
    const cursor = reset ? '' : observabilityRuns.nextCursor;
    if (!reset && !cursor) return observabilityRuns;
    const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await get(`/api/observability/runs?limit=20&windowMs=${windowMs}${cursorQuery}`);
    observabilityRuns.items = reset ? (page.items || []) : [...observabilityRuns.items, ...(page.items || [])];
    observabilityRuns.nextCursor = page.nextCursor || null;
    observabilityRuns.hasMore = Boolean(page.hasMore && observabilityRuns.nextCursor);
    renderRuns({ ...page, items: observabilityRuns.items, hasMore: observabilityRuns.hasMore });
    return observabilityRuns;
  }

  async function loadAll() {
    setStatus(T('observabilityStatus.loading', 'Loading observability…'));
    byId('obstoolmeta').textContent = T('observability.toolUsage.subtitle', `workspace-scoped · ${observabilityWindowLabel()}`, { window: observabilityWindowLabel() });
    try {
      const windowMs = observabilityWindow();
      const [metrics, , , queue, alerts] = await Promise.all([
        get(`/api/observability/metrics?windowMs=${windowMs}`),
        loadRuns(true),
        loadEventHistory(true),
        get('/api/observability/queue?limit=20'),
        get('/api/observability/alerts?limit=20'),
      ]);
      renderMetrics(metrics);
      renderQueue(queue);
      renderAlerts(alerts);
      setObservabilityReadiness(true, '');
      setStatus(T('observabilityStatus.ready', 'Live and persistent observability ready.'));
    } catch (error) {
      setObservabilityReadiness(false, observabilityUnavailableDetail(error));
      setStatus(T('observabilityStatus.error', `Observability could not be loaded: ${error.message}`, { message: error.message }));
    }
  }

  const {renderMetrics,renderRuns,renderQueue,renderAlerts,renderEventHistory,appendEvent} = window.HUQAN_OBS_RENDER({byId,T,escape,formatDuration,formatTokens,formatCount,observabilityWindowLabel,observabilityEvents,rememberStreamEvent});
  const {setObservabilityReadiness,observabilityUnavailableDetail} = window.HUQAN_OBS_READINESS({byId,T,workspace});
  const connectStream = window.HUQAN_OBS_STREAM({workspace,headers,appendEvent,loadAll,setStatus,T,STREAM_BASE_RECONNECT_DELAY_MS,STREAM_MAX_RECONNECT_DELAY_MS});
  document.addEventListener('DOMContentLoaded', () => {
    // Closed until the backend says otherwise (#1825). The controls are enabled
    // by the first successful read, so an unconfigured deployment never shows
    // an operable dashboard even for the moment before its requests fail.
    setObservabilityReadiness(false, T('observabilityStatus.checking', 'CHECKING - confirming observability is available for this workspace.'));
    byId('obsrefresh')?.addEventListener('click', () => { loadAll(); connectStream(); });
    byId('obswindow')?.addEventListener('change', loadAll);
    const eventLoadError = error => { byId('obseventstatus').textContent = T('observability.events.loadError', `Event history could not be loaded: ${error.message}`, { message: error.message }); };
    byId('obsrunsnext')?.addEventListener('click', () => loadRuns(false).catch(error => setStatus(T('observability.runs.loadError', `Run history could not be loaded: ${error.message}`, { message: error.message }))));
    byId('obseventapply')?.addEventListener('click', () => loadEventHistory(true).catch(eventLoadError));
    byId('obseventnext')?.addEventListener('click', () => loadEventHistory(false).catch(eventLoadError));
    byId('obsqueueform')?.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await post('/api/observability/queue', { goal: byId('obsgoal').value, maxSteps: Number(byId('obsmaxsteps').value || 4) });
        byId('obsgoal').value = '';
        await loadAll();
      } catch (error) { setStatus(T('observability.queue.error', `Could not queue: ${error.message}`, { message: error.message })); }
    });
    byId('obsalertform')?.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await post('/api/observability/alert-rules', {
          name: byId('obsalertname').value,
          metric: byId('obsalertmetric').value,
          operator: byId('obsalertoperator').value,
          threshold: Number(byId('obsalertthreshold').value),
          windowMs: Number(byId('obsalertwindow').value || 300000),
        });
        byId('obsalertname').value = '';
        await loadAll();
      } catch (error) { setStatus(T('observability.alerts.error', `Could not create alert rule: ${error.message}`, { message: error.message })); }
    });
    document.querySelector('[data-v="observability"]')?.addEventListener('click', () => { loadAll(); connectStream(); });
    byId('refresh')?.addEventListener('click', loadAll);
  });
})();
