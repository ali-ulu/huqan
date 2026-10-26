'use strict';
// HUQAN Trust Command Center – 7-day trend chart, parity with Control Room
// Real data only, no fabrication. Shows empty state when no data.
(function() {
  const WINDOW_MS = 604800000;

  function summaryText(pass, review, block) {
    return T('overview.trend.summary', `7-day agent activity summary: ${pass} passed, ${review} review, ${block} blocked actions.`, { pass, review, block });
  }

  function lastSevenDays(items) {
    const today = new Date(); today.setHours(0,0,0,0);
    // i18n sets <html lang>, so weekday names follow the selected locale.
    const weekday = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { weekday: 'short' });
    const days = Array.from({length:7}, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (6 - i));
      return { key: d.toDateString(), label: i===6 ? T('overview.trend.today','Today') : weekday.format(d), pass:0, review:0, block:0 };
    });
    const byKey = new Map(days.map(d => [d.key, d]));
    items.forEach(item => {
      const created = item.createdAt || item.timestamp;
      if (!created) return;
      const day = byKey.get(new Date(created).toDateString());
      if (!day) return;
      const status = String(item.status || item.receipt?.decision || '').toLowerCase();
      if (status === 'block') day.block += 1;
      else if (status === 'review') day.review += 1;
      // Auto-approved actions are allowed actions, so they plot in the pass band.
      else if (status === 'allow') day.pass += 1;
    });
    return days;
  }

  function niceMax(v) {
    if (v <= 4) return 4;
    const step = 10 ** Math.floor(Math.log10(v));
    return Math.ceil(v / step) * step;
  }

  function smoothPath(points, move) {
    const f = n => n.toFixed(1);
    return points.map((pt, i) => {
      if (i === 0) return `${move}${f(pt[0])},${f(pt[1])}`;
      const p0 = points[i-2] || points[i-1];
      const p1 = points[i-1];
      const p3 = points[i+1] || pt;
      return `C${f(p1[0] + (pt[0] - p0[0])/6)},${f(p1[1] + (pt[1] - p0[1])/6)} ${f(pt[0] - (p3[0] - p1[0])/6)},${f(pt[1] - (p3[1] - p1[1])/6)} ${f(pt[0])},${f(pt[1])}`;
    }).join(' ');
  }

  function renderTrendChart(items) {
    // The SVG lives in its own host so a re-render never removes the status nodes.
    const container = document.getElementById('trend-svg');
    const statusEl = document.getElementById('trend-status');
    const emptyEl = document.getElementById('trend-empty');
    const summaryEl = document.getElementById('trend-summary');
    if (!container) return;

    if (!Array.isArray(items) || items.length === 0) {
      if (statusEl) statusEl.textContent = T('overview.trend.noData','No data available');
      if (emptyEl) { emptyEl.textContent = T('overview.trend.empty','No activity in the last 7 days.'); emptyEl.hidden = false; }
      if (summaryEl) summaryEl.textContent = summaryText(0, 0, 0);
      container.innerHTML = '';
      return;
    }

    const data = lastSevenDays(items);
    const totals = data.map(d => d.pass + d.review + d.block);
    const totalSum = totals.reduce((a,b)=>a+b,0);

    // Show empty state when totals sum to zero (even if items non-empty)
    if (totalSum === 0) {
      if (statusEl) statusEl.textContent = T('overview.trend.empty','No activity in the last 7 days.');
      if (emptyEl) { emptyEl.textContent = T('overview.trend.empty','No activity in the last 7 days.'); emptyEl.hidden = false; }
      if (summaryEl) summaryEl.textContent = summaryText(0, 0, 0);
      container.innerHTML = '';
      return;
    }

    // Clear any previous chart on successful render
    if (emptyEl) emptyEl.hidden = true;
    if (statusEl) statusEl.textContent = '';

    const max = niceMax(Math.max(...totals, 1));
    // TOP, not T: a local T would shadow the i18n helper for the whole function.
    const W = 720, H = 240, L = 40, R = 18, TOP = 18, B = 30;
    const y = v => TOP + (H - TOP - B) * (1 - v / max);
    const x = i => L + i * (W - L - R) / (data.length - 1);

    const cum = {
      pass: data.map(d => d.pass),
      review: data.map(d => d.pass + d.review),
      block: data.map(d => d.pass + d.review + d.block),
      total: totals
    };
    const pts = arr => arr.map((v,i) => [x(i), y(v)]);
    const zero = data.map(() => 0);

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Agent activity trend for the last 7 days"><defs>
      <linearGradient id="g-pass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--color-pass)" stop-opacity=".72"/><stop offset="1" stop-color="var(--color-pass)" stop-opacity=".16"/></linearGradient>
      <linearGradient id="g-review" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--color-review)" stop-opacity=".72"/><stop offset="1" stop-color="var(--color-review)" stop-opacity=".16"/></linearGradient>
      <linearGradient id="g-block" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--color-block)" stop-opacity=".72"/><stop offset="1" stop-color="var(--color-block)" stop-opacity=".16"/></linearGradient>
    </defs>`;

    [0,0.25,0.5,0.75,1].forEach(fr => {
      const v = Math.round(max * fr);
      svg += `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--color-line)" stroke-dasharray="2 6"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end" font-size="10" fill="var(--color-muted)">${v}</text>`;
    });

    const bands = [
      ['pass','g-pass','--color-pass', zero, cum.pass],
      ['review','g-review','--color-review', cum.pass, cum.review],
      ['block','g-block','--color-block', cum.review, cum.block]
    ];
    bands.forEach(([k,g,c,lo,hi]) => {
      svg += `<path d="${smoothPath(pts(hi),'M')} ${smoothPath(pts(lo).reverse(),'L')} Z" fill="url(#${g})"/>`;
      svg += `<path d="${smoothPath(pts(hi),'M')}" fill="none" stroke="var(${c})" stroke-width="1.6" stroke-linecap="round"/>`;
    });

    // labels
    data.forEach((d,i) => {
      svg += `<text x="${x(i)}" y="${H-8}" text-anchor="${i===0?'start':i===6?'end':'middle'}" font-size="10" fill="${i===6?'var(--color-ink)':'var(--color-muted)'}">${d.label}</text>`;
    });

    svg += `</svg>`;
    container.innerHTML = svg;
    if (statusEl) statusEl.textContent = T('overview.trend.total', `7-day trend · ${totalSum} actions`, { count: totalSum });
    if (emptyEl) emptyEl.hidden = true;
    // Update accessible summary
    const totalPass = data.reduce((a,d)=>a+d.pass,0);
    const totalReview = data.reduce((a,d)=>a+d.review,0);
    const totalBlock = data.reduce((a,d)=>a+d.block,0);
    if (summaryEl) summaryEl.textContent = summaryText(totalPass, totalReview, totalBlock);
  }

  // Only the newest load may touch the DOM; an older one finishing last is dropped.
  let trendSeq = 0;

  async function loadTrend() {
    const seq = ++trendSeq;
    try {
      const ws = (window.state && state.ws) || 'default';
      const cutoff = Date.now() - WINDOW_MS;
      let allItems = [];
      let cursor = null;
      let hasMore = true;

      // Pages arrive newest first and the route has no time filter, so stop
      // at the first page that reaches past the seven-day window.
      while (hasMore) {
        const q = new URLSearchParams({ workspaceId: ws, order: 'desc' });
        if (cursor) q.set('cursor', cursor);
        const res = await fetch(`/api/workbench/activity?${q}`, { headers: headers ? headers() : {} });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!d.ok || !Array.isArray(d.items)) throw new Error(T('overview.trend.invalidResponse','Invalid response'));
        allItems.push(...d.items);
        cursor = d.nextCursor || null;
        const last = d.items[d.items.length - 1];
        const oldest = last ? Date.parse(last.createdAt || last.timestamp || '') : NaN;
        hasMore = Boolean(d.hasMore && cursor) && !(oldest < cutoff);
      }

      if (seq !== trendSeq) return;
      renderTrendChart(allItems);
    } catch (e) {
      if (seq !== trendSeq) return;
      const container = document.getElementById('trend-svg');
      const el = document.getElementById('trend-status');
      const empty = document.getElementById('trend-empty');
      const summaryEl = document.getElementById('trend-summary');
      if (el) el.textContent = T('overview.trend.failed', `Trend load failed: ${e.message}`, { message: e.message });
      if (empty) { empty.textContent = T('overview.trend.unavailable','Trend data unavailable'); empty.hidden = false; }
      if (container) container.innerHTML = ''; // Clear chart on failure
      if (summaryEl) summaryEl.textContent = summaryText(0, 0, 0);
    }
  }

  // Hook into overview refresh
  document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', loadTrend);
    }
    const isActive = () => {
      const ov = document.getElementById('v-overview');
      return Boolean(ov && ov.classList.contains('active'));
    };
    // Load once for the overview that is already active in the markup.
    let wasActive = isActive();
    if (wasActive) loadTrend();
    // Reload only when the overview becomes active. A body-wide class
    // observer fires on every class change on the page, so gating on the
    // transition (not the current state) is what keeps it from starting a
    // fetch on each one.
    const observer = new MutationObserver(() => {
      const active = isActive();
      if (active && !wasActive) loadTrend();
      wasActive = active;
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter:['class'] });
    // Redraw so weekday labels, counts and the summary follow the new locale.
    window.addEventListener('huqan-locale-change', () => { if (isActive()) loadTrend(); });
  });

  window.HuqanOverviewTrend = { loadTrend, renderTrendChart };
})();