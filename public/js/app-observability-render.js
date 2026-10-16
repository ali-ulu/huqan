'use strict';
window.HUQAN_OBS_RENDER = ({byId,T,escape,formatDuration,formatTokens,formatCount,observabilityWindowLabel,observabilityEvents,rememberStreamEvent}) => {
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
    const mismatchSuffix = ` · ${T('observability.toolUsage.totalMismatch', 'total mismatch')}`;
    if (meta) {
      const base = meta.textContent.endsWith(mismatchSuffix) ? meta.textContent.slice(0, -mismatchSuffix.length) : meta.textContent;
      meta.textContent = `${base}${totalMismatch ? mismatchSuffix : ''}`;
    }
    byId('obstooltotal').textContent = formatCount(total);
    if (!total) {
      donut.style.setProperty('--tool-gradient', 'conic-gradient(#dcebf7 0 100%)');
      donut.setAttribute('aria-label', T('emptyStates.noToolCalls', 'No tool calls yet'));
      legend.innerHTML = `<div class="empty">${escape(T('observability.toolUsage.empty', 'No tool calls yet.'))}</div>`;
      return;
    }
    if (!normalized.length) {
      donut.style.setProperty('--tool-gradient', 'conic-gradient(#64748b 0 100%)');
      donut.setAttribute('aria-label', T('observability.toolUsage.breakdownUnavailableAria', `Tool usage breakdown unavailable: ${total} calls`, { total }));
      legend.innerHTML = `<div class="empty">${escape(T('observability.toolUsage.breakdownUnavailable', 'Tool usage breakdown unavailable.'))}</div>`;
      return;
    }
    const items = total > usageTotal ? [...normalized, { name: T('observability.toolUsage.unattributedName', 'Unattributed'), count: total - usageTotal, color: '#64748b' }] : normalized;
    let cursor = 0;
    const slices = items.map(tool => {
      const percent = tool.count / total * 100;
      const start = cursor;
      cursor += percent;
      return { ...tool, percent, slice: `${tool.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%` };
    });
    donut.style.setProperty('--tool-gradient', `conic-gradient(${slices.map(tool => tool.slice).join(',')})`);
    donut.setAttribute('aria-label', `${T('observability.toolUsage.distributionAria', `Tool usage distribution: ${total} calls`, { total })}${totalMismatch ? T('observability.toolUsage.breakdownIncomplete', '; breakdown incomplete') : ''}`);
    legend.innerHTML = slices.map(tool => `<div class="toollegend-item" style="--tool-color:${tool.color}" title="${escape(tool.name)}"><i aria-hidden="true"></i><b>${escape(tool.name)}</b><span>${escape(formatCount(tool.count))} · ${escape(`${Math.round(tool.percent)}%`)}</span></div>`).join('');
  }

  function renderMetrics(data) {
    const metrics = data.metrics || {};
    const queue = data.queue || {};
    byId('obstotal').textContent = metrics.totalRuns ?? '—';
    byId('obssuccess').textContent = metrics.successRate === null || metrics.successRate === undefined ? '—' : `${Math.round(metrics.successRate * 100)}%`;
    byId('obslatency').textContent = formatDuration(metrics.p95LatencyMs ?? metrics.avgLatencyMs);
    byId('obstokens').textContent = formatTokens(metrics.totalTokens);
    byId('obscost').textContent = metrics.costKnown ? T('observability.costUnits', `${(Number(metrics.totalCostMicros || 0) / 1e6).toFixed(4)} units`, { amount: (Number(metrics.totalCostMicros || 0) / 1e6).toFixed(4) }) : T('observability.notMeasured', 'not measured');
    byId('obsqueue').textContent = queue.depth ?? '—';
    renderToolUsage(metrics);
    const alerts = data.alerts || [];
    byId('obsalertcount').textContent = alerts.length;
  }

  function renderRuns(data) {
    const items = data.items || [];
    byId('obsrunsnext').disabled = !data.hasMore;
    byId('obsrunsmeta').textContent = T('observability.runs.meta', `${items.length} rows · ${data.hasMore ? 'next page available' : 'bounded page'}`, {
      count: items.length,
      state: data.hasMore ? T('observability.runs.nextPage', 'next page available') : T('observability.runs.boundedPage', 'bounded page'),
    });
    byId('obsruns').innerHTML = items.map(run => {
      const tools = Array.isArray(run.tools) ? run.tools : [];
      const toolText = tools.length ? tools.map(tool => `${escape(tool.name)} ×${escape(tool.count)}`).join(', ') : T('observability.runs.toolText', 'no tools used');
      const toolCalls = run.toolCallCount ?? tools.reduce((total, tool) => total + Number(tool.count || 0), 0);
      return `<div class="item"><b>${escape(run.status)}</b> · ${escape(run.runtime)} · ${escape(run.runId.slice(0, 12))}<div class="sub">${escape(T('observability.runs.toolsLabel', 'Tools:'))} ${toolText} · ${escape(T('observability.runs.calls', `${toolCalls} calls`, { count: toolCalls }))}</div></div><small>${escape(run.updatedAt)} · ${escape(formatDuration(run.durationMs))} · ${escape(T('observability.runs.tokens', `${formatTokens(run.tokens)} token`, { tokens: formatTokens(run.tokens) }))}</small>`;
    }).join('') || `<div class="empty">${escape(T('observability.runs.empty', 'No persistent runs yet.'))}</div>`;
  }

  function renderQueue(data) {
    const items = data.items || [];
    byId('obsqueueitems').innerHTML = items.map(job => `<div class="item"><b>${escape(job.status)}</b> · ${escape(job.jobId.slice(0, 12))}<small>${escape(T('observability.queue.goalChars', `${job.goalLength} characters`, { length: job.goalLength }))} · ${escape(T('observability.queue.attempts', `${job.attempts}/${job.maxAttempts} attempts`, { attempts: job.attempts, maxAttempts: job.maxAttempts }))}</small></div>`).join('') || `<div class="empty">${escape(T('observability.queue.empty', 'Queue is empty.'))}</div>`;
  }

  function renderAlerts(data) {
    const items = data.items || [];
    byId('obsalerts').innerHTML = items.map(alert => `<div class="item"><b>${escape(alert.metric)}</b> · ${escape(alert.value)} / ${escape(alert.threshold)}<small>${escape(alert.firedAt)}</small></div>`).join('') || `<div class="empty">${escape(T('observability.alerts.empty', 'No active alerts.'))}</div>`;
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
    byId('obseventmeta').textContent = T('observability.events.meta', `${items.length} rows · ${data.hasMore ? 'next page available' : 'bounded page'}`, {
      count: items.length,
      state: data.hasMore ? T('observability.events.nextPage', 'next page available') : T('observability.events.boundedPage', 'bounded page'),
    });
    byId('obseventhistory').innerHTML = items.map(event => `<div class="item"><b>${escape(event.eventType)}</b> · ${escape(event.status || '—')} · ${escape(event.createdAt)}<div class="sub">${escape(T('observability.events.runLabel', 'Run:'))} ${escape(event.runId || '—')} · ${escape(T('observability.events.toolLabel', 'Tool:'))} ${escape(event.tool || '—')} · ${escape(T('observability.events.durationLabel', 'Duration:'))} ${escape(formatDuration(event.durationMs))}</div></div>`).join('') || `<div class="empty">${escape(T('observability.events.empty', 'No matching events in this window.'))}</div>`;
  }
  return {renderMetrics,renderRuns,renderQueue,renderAlerts,renderEventHistory,appendEvent};
};
