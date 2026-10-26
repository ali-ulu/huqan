'use strict';
// HUQAN Trust Command Center – 7-day trend chart, parity with Control Room
// Real data only, no fabrication. Shows empty state when no data.
(function() {
  const DAY_MS = 86400000;
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const WINDOW_MS = 604800000;

  function lastSevenDays(items) {
    const today = new Date(); today.setHours(0,0,0,0);
    const days = Array.from({length:7}, (_, i) => {
      const d = new Date(today.getTime() - (6 - i) * DAY_MS);
      return { key: d.toDateString(), label: i===6 ? 'Today' : DAY_NAMES[d.getDay()], pass:0, review:0, block:0, auto:0 };
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
      else if (status === 'allow') {
        const auto = item.payload?.metadata?.autoApproved === true;
        if (auto) day.auto += 1; else day.pass += 1;
      }
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
    const container = document.getElementById('trend-chart');
    const statusEl = document.getElementById('trend-status');
    const emptyEl = document.getElementById('trend-empty');
    const summaryEl = document.getElementById('trend-summary');
    if (!container) return;

    if (!Array.isArray(items) || items.length === 0) {
      if (statusEl) statusEl.textContent = 'No data available';
      if (emptyEl) emptyEl.hidden = false;
      if (summaryEl) summaryEl.textContent = '7-day agent activity summary: 0 passed, 0 review, 0 blocked actions.';
      container.innerHTML = '';
      return;
    }

    const data = lastSevenDays(items);
    const totals = data.map(d => d.pass + d.review + d.block + d.auto);
    const totalSum = totals.reduce((a,b)=>a+b,0);

    // Show empty state when totals sum to zero (even if items non-empty)
    if (totalSum === 0) {
      if (statusEl) statusEl.textContent = 'No activity in the last 7 days.';
      if (emptyEl) emptyEl.hidden = false;
      if (summaryEl) summaryEl.textContent = '7-day agent activity summary: 0 passed, 0 review, 0 blocked actions.';
      container.innerHTML = '';
      return;
    }

    // Clear any previous chart on successful render
    if (emptyEl) emptyEl.hidden = true;
    if (statusEl) statusEl.textContent = '';

    const max = niceMax(Math.max(...totals, 1));
    const W = 720, H = 240, L = 40, R = 18, T = 18, B = 30;
    const y = v => T + (H - T - B) * (1 - v / max);
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
    if (statusEl) statusEl.textContent = `7-day trend · ${totalSum} actions`;
    if (emptyEl) emptyEl.hidden = true;
    // Update accessible summary
    const totalPass = data.reduce((a,d)=>a+d.pass,0);
    const totalReview = data.reduce((a,d)=>a+d.review,0);
    const totalBlock = data.reduce((a,d)=>a+d.block,0);
    if (summaryEl) summaryEl.textContent = `7-day agent activity summary: ${totalPass} passed, ${totalReview} review, ${totalBlock} blocked actions.`;
  }

  async function loadTrend() {
    try {
      const ws = (window.state && state.ws) || 'default';
      let allItems = [];
      let cursor = null;
      let hasMore = true;

      // Follow cursor to get all 7-day activity
      while (hasMore) {
        const q = new URLSearchParams({ workspaceId: ws, windowMs: String(WINDOW_MS) });
        if (cursor) q.set('cursor', cursor);
        const res = await fetch(`/api/workbench/activity?${q}`, { headers: headers ? headers() : {} });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!d.ok || !Array.isArray(d.items)) throw new Error('Invalid response');
        allItems.push(...d.items);
        cursor = d.nextCursor || null;
        hasMore = Boolean(d.hasMore && cursor);
      }

      renderTrendChart(allItems);
    } catch (e) {
      const container = document.getElementById('trend-chart');
      const el = document.getElementById('trend-status');
      const empty = document.getElementById('trend-empty');
      const summaryEl = document.getElementById('trend-summary');
      if (el) el.textContent = `Trend load failed: ${e.message}`;
      if (empty) { empty.textContent = 'Trend data unavailable'; empty.hidden = false; }
      if (container) container.innerHTML = ''; // Clear chart on failure
      if (summaryEl) summaryEl.textContent = '7-day agent activity summary: 0 passed, 0 review, 0 blocked actions.';
    }
  }

  // Hook into overview refresh
  document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', loadTrend);
    }
    // Initial load when overview is visible (call explicitly for active overview)
    const ov = document.getElementById('v-overview');
    if (ov && ov.classList.contains('active')) {
      loadTrend();
    }
    // Watch for overview activation changes
    const observer = new MutationObserver(() => {
      const ov = document.getElementById('v-overview');
      if (ov && ov.classList.contains('active')) loadTrend();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter:['class'] });
  });

  window.HuqanOverviewTrend = { loadTrend, renderTrendChart };
})();