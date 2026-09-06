
'use strict';

(function() {
  'use strict';

  const byId = id => document.getElementById(id);
  const t = (key, params) => window.HUQAN_I18N?.t(key, params) ?? key;

  const workspace = () => (byId('workspace')?.value || byId('ws')?.value || 'default').trim() || 'default';
  const headers = () => {
    const key = sessionStorage.getItem('huqan-api-key') || '';
    return key ? { Authorization: `Bearer ${key}` } : {};
  };
  const get = async (path) => {
    const response = await fetch(`${path}${path.includes('?') ? '&' : '?'}workspaceId=${encodeURIComponent(workspace())}`, { headers: headers(), cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
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
  const formatTokens = value => value === null || value === undefined ? t('observability.metrics.tokensDesc') : Number(value).toLocaleString('en-US');
  const setStatus = text => { if (byId('obsstatus')) byId('obsstatus').textContent = text; };
  const observabilityRuns = { items: [], nextCursor: null, hasMore: false };
  const observabilityEvents = { items: [], nextCursor: null, hasMore: false, eventType: '', runId: '' };
  const observabilityWindow = () => {
    const value = Number(byId('obswindow')?.value);
    return Number.isSafeInteger(value) && value >= 1000 ? value : 24 * 60 * 60 * 1000;
  };
  const observabilityWindowLabel = () => byId('obswindow')?.selectedOptions?.[0]?.textContent || t('observability.windowFilter');
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

  function renderToolUsage(metrics) {
    const usage = Array.isArray(metrics.toolUsage) ? metrics.toolUsage : [];
    const colors = ['#1688ff', '#16b77a', '#dfa31b', '#ee5067', '#8b5cf6', '#24c8ff', '#f97316', '#64748b'];
    const counts = new Map();
    usage.forEach(tool => {
      const count = Number(tool?.count);
      if (!Number.isFinite(count) || count <= 0) return;
      const name = String(tool?.name || 'unknown');
      counts.set(name, (counts.get(name) || 0) + count);
    });
    const normalized = [...counts.entries()].map(([name, count], index) => ({ name, count, color: colors[index % colors.length] }));
    const usageTotal = normalized.reduce((sum, tool) => sum + tool.count, 0);
    const reportedTotal = Number(metrics.toolCallCount);
    const hasReportedTotal = Number.isFinite(reportedTotal) && reportedTotal >= 0;
    const totalMismatch = hasReportedTotal && reportedTotal !== usageTotal;
    const total = hasReportedTotal ? Math.max(reportedTotal, usageTotal) : usageTotal;
    const donut = byId('obstooldonut');
    const legend = byId('obstoollegend');
    const meta = byId('obstoolmeta');
    if (meta) meta.textContent = `${t('observability.toolUsage.subtitle')}${totalMismatch ? ' · ' + t('observability.toolUsage.totalMismatch', {}) : ''}`;
    byId('obstooltotal').textContent = total.toLocaleString('en-US');
    if (!total) {
      donut.style.setProperty('--tool-gradient', 'conic-gradient(#dcebf7 0 100%)');
      donut.setAttribute('aria-label', t('emptyStates.noToolCalls'));
      legend.innerHTML = `<div class="empty" data-i18n="emptyStates.noToolCalls">${t('emptyStates.noToolCalls')}</div>`;
      return;
    }
    if (!normalized.length) {
      donut.style.setProperty('--tool-gradient', 'conic-gradient(#64748b 0 100%)');
      donut.setAttribute('aria-label', `${t('observability.toolUsage.unavailable', { total })}`);
      legend.innerHTML = `<div class="empty" data-i18n="observability.toolUsage.unavailable">${t('observability.toolUsage.unavailable', { total })}</div>`;
      return;
    }
    const items = total > usageTotal ? [...normalized, { name: t('observability.toolUsage.unattributed', { count: total - usageTotal }), count: total - usageTotal, color: '#64748b' }] : normalized;
    let cursor = 0;
    const slices = items.map(tool => {
      const percent = tool.count / total * 100;
      const start = cursor;
      cursor += percent;
      return { ...tool, percent, slice: `${tool.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%` };
    });
    donut.style.setProperty('--tool-gradient', `conic-gradient(${slices.map(tool => tool.slice).join(',')})`);
    donut.setAttribute('aria-label', `Tool usage distribution: ${total} calls${totalMismatch ? '; breakdown incomplete' : ''}`);
    legend.innerHTML = slices.map(tool => `<div class="toollegend-item" style="--tool-color:${tool.color}" title="${escape(tool.name)}"><i aria-hidden="true"></i><b>${escape(tool.name)}</b><span>${escape(tool.count.toLocaleString('en-US'))} · ${escape(`${Math.round(tool.percent)}%`)}</span></div>`).join('');
  }

  function renderMetrics(data) {
    const metrics = data.metrics || {};
    const queue = data.queue || {};
    byId('obstotal').textContent = metrics.totalRuns ?? '—';
    byId('obssuccess').textContent = metrics.successRate === null || metrics.successRate === undefined ? '—' : `${Math.round(metrics.successRate * 100)}%`;
    byId('obslatency').textContent = formatDuration(metrics.p95LatencyMs ?? metrics.avgLatencyMs);
    byId('obstokens').textContent = formatTokens(metrics.totalTokens);
    byId('obscost').textContent = metrics.costKnown ? `${(Number(metrics.totalCostMicros || 0) / 1e6).toFixed(4)} units` : t('observability.metrics.tokensDesc');
    byId('obsqueue').textContent = queue.depth ?? '—';
    renderToolUsage(metrics);
    const alerts = data.alerts || [];
    byId('obsalertcount').textContent = alerts.length;
  }

  function renderRuns(data) {
    const items = data.items || [];
    byId('obsrunsnext').disabled = !data.hasMore;
    const pageMeta = data.hasMore ? t('observability.runs.nextPage') : t('observability.runs.boundedPage');
    byId('obsrunsmeta').textContent = `${items.length} rows · ${pageMeta}`;
    byId('obsruns').innerHTML = items.map(run => {
      const tools = Array.isArray(run.tools) ? run.tools : [];
      const toolText = tools.length ? tools.map(t => `${escape(t.name)} ×${escape(t.count)}`).join(', ') : t('observability.runs.toolText');
      const toolCalls = run.toolCallCount ?? tools.reduce((total, tool) => total + Number(tool.count || 0), 0);
      return `<div class="item"><b>${escape(run.status)}</b> · ${escape(run.runtime)} · ${escape(run.runId.slice(0, 12))}<div class="sub">Tools: ${toolText} · ${escape(toolCalls)} calls</div></div><small>${escape(run.updatedAt)} · ${escape(formatDuration(run.durationMs))} · ${escape(formatTokens(run.tokens))} token</small>`;
    }).join('') || `<div class="empty" data-i18n="emptyStates.noRuns">${t('emptyStates.noRuns')}</div>`;
  }

  function renderQueue(data) {
    const items = data.items || [];
    byId('obsqueueitems').innerHTML = items.map(job => `<div class="item"><b>${escape(job.status)}</b> · ${escape(job.jobId.slice(0, 12))}<small>${escape(t('observability.queue.goalChars', { length: job.goalLength }))} · ${escape(t('observability.queue.attempts', { attempts: job.attempts, maxAttempts: job.maxAttempts }))}</small></div>`).join('') || `<div class="empty" data-i18n="emptyStates.noQueue">${t('emptyStates.noQueue')}</div>`;
  }

  function renderAlerts(data) {
    const items = data.items || [];
    byId('obsalerts').innerHTML = items.map(alert => `<div class="item"><b>${escape(alert.metric)}</b> · ${escape(alert.value)} / ${escape(alert.threshold)}<small>${escape(alert.firedAt)}</small></div>`).join('') || `<div class="empty" data-i18n="emptyStates.noAlerts">${t('emptyStates.noAlerts')}</div>`;
  }

  function appendEvent(event) {
    if (!rememberStreamEvent(event)) return false;
    const box = byId('obsevents');
    const line = `${event.createdAt || new Date().toISOString()} · ${event.eventType} · ${event.status || '—'}${event.tool ? ` · ${event.tool}` : ''}`;
    box.textContent = `${line}\n${box.textContent}`.split('\n').slice(0, 30).join('\n');
    return true;
  }
  function renderEventHistory(data) {
    const items = data.items || [];
    byId('obseventnext').disabled = !data.hasMore;
    const pageMeta = data.hasMore ? t('observability.events.nextPage') : t('observability.events.boundedPage');
    byId('obseventmeta').textContent = `${items.length} rows · ${pageMeta}`;
    byId('obseventhistory').innerHTML = items.map(event => `<div class="item"><b>${escape(event.eventType)}</b> · ${escape(event.status || '—')} · ${escape(event.createdAt)}<div class="sub">Run: ${escape(event.runId || '—')} · Tool: ${escape(event.tool || '—')} · Duration: ${escape(formatDuration(event.durationMs))}</div></div>`).join('') || `<div class="empty" data-i18n="emptyStates.noEvents">${t('emptyStates.noEvents')}</div>`;
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
    byId('obseventstatus').textContent = reset ? t('observability.events.loading') : t('observability.events.loadingNext');
    let page;
    try {
      page = await get(`/api/observability/events?${query.toString()}`);
    } catch (error) {
      byId('obseventstatus').textContent = t('observability.events.loadError', { message: error.message });
      throw error;
    }
    observabilityEvents.items = reset ? (page.items || []) : [...observabilityEvents.items, ...(page.items || [])];
    observabilityEvents.nextCursor = page.nextCursor || null;
    observabilityEvents.hasMore = Boolean(page.hasMore && observabilityEvents.nextCursor);
    renderEventHistory({ ...page, items: observabilityEvents.items, hasMore: observabilityEvents.hasMore });
    const evType = observabilityEvents.eventType ? ` · ${observabilityEvents.eventType}` : '';
    const evRun = observabilityEvents.runId ? ` · run ${observabilityEvents.runId}` : '';
    byId('obseventstatus').textContent = t('observability.events.summary', {
      count: observabilityEvents.items.length,
      window: observabilityWindowLabel(),
      eventType: evType,
      runId: evRun
    });
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

  // Observability readiness (#1825).
  const OBSERVABILITY_CONTROLS = [
    'obsgoal', 'obsmaxsteps', 'obsalertname', 'obsalertmetric',
    'obsalertoperator', 'obsalertthreshold', 'obsalertwindow',
  ];

  function observabilityFormButtons() {
    return ['obsqueueform', 'obsalertform']
      .map(id => byId(id)?.querySelector('button[type="submit"]'))
      .filter(Boolean);
  }

  function setObservabilityReadiness(ready, detail) {
    const banner = byId('obsreadiness');
    for (const id of OBSERVABILITY_CONTROLS) {
      const el = byId(id);
      if (!el) continue;
      if (ready) {
        if (el.dataset.obsGated === '1') { el.disabled = false; delete el.dataset.obsGated; }
      } else if (!el.disabled) {
        el.disabled = true;
        el.dataset.obsGated = '1';
      }
    }
    for (const button of observabilityFormButtons()) {
      if (ready) {
        if (button.dataset.obsGated === '1') { button.disabled = false; delete button.dataset.obsGated; }
      } else if (!button.disabled) {
        button.disabled = true;
        button.dataset.obsGated = '1';
      }
    }
    if (!banner) return;
    banner.hidden = Boolean(ready);
    banner.textContent = ready ? '' : detail;
  }

  function observabilityUnavailableDetail(error) {
    if (error?.code === 'OBSERVABILITY_AUTHORIZATION_UNAVAILABLE') {
      return t('observabilityStatus.unavailable.notConfigured');
    }
    if (error?.code === 'OBSERVABILITY_WORKSPACE_FORBIDDEN' || error?.code === 'OBSERVABILITY_PERMISSION_FORBIDDEN') {
      return t('observabilityStatus.unavailable.workspaceForbidden', { workspace: workspace() });
    }
    if (error?.status === 401) {
      return t('observabilityStatus.unavailable.authRequired');
    }
    return t('observabilityStatus.unavailable.generic', { message: error?.message || t('common.error') });
  }

  async function loadAll() {
    setStatus(t('observabilityStatus.loading'));
    byId('obstoolmeta').textContent = `workspace-scoped · ${observabilityWindowLabel()}`;
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
      setStatus(t('observabilityStatus.ready'));
    } catch (error) {
      setObservabilityReadiness(false, observabilityUnavailableDetail(error));
      setStatus(t('observabilityStatus.error', { message: error.message }));
    }
  }

  function connectStream() {
    if (window.__huqanObservabilityStream) window.__huqanObservabilityStream.close();
    const streamState = { closed: false, retryAttempt: 0, controller: null, timer: null, close: null };
    streamState.close = () => {
      streamState.closed = true;
      if (streamState.timer) clearTimeout(streamState.timer);
      if (streamState.controller) streamState.controller.abort();
    };
    window.__huqanObservabilityStream = streamState;
    const open = () => {
      if (streamState.closed) return;
      const controller = new AbortController();
      streamState.controller = controller;
      const query = new URLSearchParams({ workspaceId: workspace() });
      fetch(`/api/observability/stream?${query.toString()}`, { headers: headers(), signal: controller.signal, cache: 'no-store' }).then(async response => {
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted && !streamState.closed) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('stream closed by server');
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split('\\n\\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const data = frame.split('\\n').find(line => line.startsWith('data: '));
            if (!data) continue;
            try {
              const event = JSON.parse(data.slice(6));
              if (event.eventType && appendEvent(event)) {
                streamState.retryAttempt = 0;
                loadAll();
              }
            } catch (_) {}
          }
        }
      }).catch(error => {
        if (streamState.closed || controller.signal.aborted) return;
        const delay = Math.min(STREAM_BASE_RECONNECT_DELAY_MS * (2 ** Math.min(streamState.retryAttempt, 4)), STREAM_MAX_RECONNECT_DELAY_MS);
        streamState.retryAttempt += 1;
        setStatus(t('observabilityStatus.reconnect', { delay }));
        streamState.timer = setTimeout(() => { streamState.timer = null; open(); }, delay);
      });
    };
    open();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const i18n = window.HUQAN_I18N;
    if (i18n) {
      setObservabilityReadiness(false, i18n.t('observabilityStatus.readiness.checking'));
    } else {
      setObservabilityReadiness(false, 'CHECKING - confirming observability is available for this workspace.');
    }
    byId('obsrefresh')?.addEventListener('click', () => { loadAll(); connectStream(); });
    byId('obswindow')?.addEventListener('change', loadAll);
    byId('obsrunsnext')?.addEventListener('click', () => loadRuns(false).catch(error => setStatus(t('observability.runs.loadError', { message: error.message }))));
    byId('obseventapply')?.addEventListener('click', () => loadEventHistory(true).catch(error => byId('obseventstatus').textContent = t('observability.events.loadError', { message: error.message })));
    byId('obseventnext')?.addEventListener('click', () => loadEventHistory(false).catch(error => byId('obseventstatus').textContent = t('observability.events.loadError', { message: error.message })));
    byId('obsqueueform')?.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await post('/api/observability/queue', { goal: byId('obsgoal').value, maxSteps: Number(byId('obsmaxsteps').value || 4) });
        byId('obsgoal').value = '';
        await loadAll();
      } catch (error) { setStatus(t('observability.queue.error', { message: error.message })); }
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
      } catch (error) { setStatus(t('observability.alerts.error', { message: error.message })); }
    });
    document.querySelector('[data-v="observability"]')?.addEventListener('click', () => { loadAll(); connectStream(); });
    byId('refresh')?.addEventListener('click', loadAll);
  });
})();
