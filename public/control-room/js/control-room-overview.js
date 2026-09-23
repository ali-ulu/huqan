'use strict';

(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, $$, esc, ago } = UI;

  let currentWindowMs = 86400000;
  const WINDOW_LABEL = { 3600000: 'the last hour', 86400000: 'the last 24 hours', 604800000: 'the last 7 days' };

  function bucketDecisions(items) {
    const c = { pass: 0, auto: 0, review: 0, block: 0 };
    let earliest = null;
    let agentsSeen = new Map();
    items.forEach((item) => {
      const status = String(item.status || '').toLowerCase();
      const auto = item.payload && item.payload.metadata && item.payload.metadata.autoApproved === true;
      if (status === 'block') c.block += 1;
      else if (status === 'review') c.review += 1;
      else if (status === 'allow' && auto) c.auto += 1;
      else if (status === 'allow') c.pass += 1;
      if (item.agentId) {
        const prev = agentsSeen.get(item.agentId);
        if (!prev || new Date(item.createdAt) > new Date(prev)) agentsSeen.set(item.agentId, item.createdAt);
      }
      if (!earliest || new Date(item.createdAt) < new Date(earliest)) earliest = item.createdAt;
    });
    return { counts: c, earliest, agentsSeen };
  }

  function sessionApproved() {
    return window.HuqanControlRoomApprovals ? window.HuqanControlRoomApprovals.getSessionApprovedCount() : 0;
  }

  function renderStatus(message, isError) {
    const el = $('#ov-status');
    if (!message) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = message;
    el.className = `status${isError ? ' bad' : ''}`;
  }

  // `counts.review` is every `review`-status gate_decision recorded in the
  // window, whether or not it has since been resolved: a gate decision is
  // only ever recorded once, at the moment the gate ran, and is never
  // re-emitted when a person later approves or rejects it (confirmed by
  // exercising the real endpoints while building this view -- see the final
  // report). Using it keeps the bar's segments summing to the total watched.
  // `openReviewCount` -- the live approval queue size -- is shown alongside
  // it as "open now" so a resolved review does not look like it vanished
  // from the total, and does not look like it is still waiting either.
  function renderVerdict(counts, openReviewCount, earliest, truncated) {
    const approved = sessionApproved();
    const total = counts.pass + approved + counts.auto + counts.review + counts.block;
    $('#ov-total').textContent = total.toLocaleString();
    $('#ov-total-label').textContent = `agent actions watched in ${WINDOW_LABEL[currentWindowMs] || 'the selected window'}`;
    const bar = $('#ov-vbar');
    const set = (name, value) => {
      const seg = bar.querySelector(`[data-bar="${name}"]`);
      if (!seg) return;
      seg.style.flexGrow = value;
      seg.hidden = !value;
    };
    set('pass', counts.pass); set('approved', approved); set('auto', counts.auto); set('review', counts.review); set('block', counts.block);
    // Auto-approved stays its own bucket (design section 3) but, like the
    // mockup's four columns, only takes a column when it actually happened.
    $('#ov-vlegend').innerHTML = `
      <div class="vl" style="--c:var(--pass)"><b class="num">${counts.pass}</b><span>Passed on policy</span></div>
      <div class="vl" style="--c:color-mix(in oklab, var(--pass) 55%, var(--surface))"><b class="num">${approved}</b><span>Passed after your approval</span></div>
      ${counts.auto ? `<div class="vl" style="--c:var(--gold)"><b class="num">${counts.auto}</b><span>Auto-approved</span></div>` : ''}
      <div class="vl" style="--c:var(--review)"><b class="num">${counts.review}</b><span>Waiting for review</span>${openReviewCount ? '<br><button class="link" data-go="approvals">Review now</button>' : ''}</div>
      <div class="vl" style="--c:var(--block)"><b class="num">${counts.block}</b><span>Blocked before they ran</span>${counts.block ? '<br><button class="link" data-jump-verdict="block">See what was stopped</button>' : ''}</div>
    `;
    $('#ov-vlegend').style.gridTemplateColumns = `repeat(${counts.auto ? 5 : 4}, minmax(0, 1fr))`;
    const byPolicy = total ? Math.round(((counts.pass + counts.block) / total) * 100) : 0;
    $('#ov-ring-pct').textContent = total ? `${byPolicy}%` : '–';
    const C = 2 * Math.PI * 26;
    $('#ring-fg').style.strokeDasharray = `${(C * byPolicy / 100).toFixed(1)} ${C.toFixed(1)}`;
    $('#ring-fg').style.visibility = byPolicy ? '' : 'hidden';
    $('#ov-since').textContent = earliest
      ? `Counting since ${new Date(earliest).toLocaleString()}${truncated ? ' · window truncated at the read cap' : ''}`
      : '';
  }

  const DAY_MS = 86400000;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function lastSevenDays(items) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today.getTime() - (6 - i) * DAY_MS);
      return { key: d.toDateString(), label: i === 6 ? 'Today' : DAY_NAMES[d.getDay()], pass: 0, review: 0, block: 0 };
    });
    const byKey = new Map(days.map((d) => [d.key, d]));
    items.forEach((item) => {
      const day = byKey.get(new Date(item.createdAt).toDateString());
      if (!day) return;
      const status = String(item.status || '').toLowerCase();
      if (status === 'block') day.block += 1;
      else if (status === 'review') day.review += 1;
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
    const f = (n) => n.toFixed(1);
    return points.map((pt, i) => {
      if (i === 0) return `${move}${f(pt[0])},${f(pt[1])}`;
      const p0 = points[i - 2] || points[i - 1];
      const p1 = points[i - 1];
      const p3 = points[i + 1] || pt;
      return `C${f(p1[0] + (pt[0] - p0[0]) / 6)},${f(p1[1] + (pt[1] - p0[1]) / 6)} ${f(pt[0] - (p3[0] - p1[0]) / 6)},${f(pt[1] - (p3[1] - p1[1]) / 6)} ${f(pt[0])},${f(pt[1])}`;
    }).join(' ');
  }

  function renderChart(weekItems) {
    const data = lastSevenDays(weekItems);
    const totals = data.map((d) => d.pass + d.review + d.block);
    const max = niceMax(Math.max(...totals));
    const W = 640, H = 240, L = 34, R = 18, T = 18, B = 30;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const x = (i) => L + i * (W - L - R) / (data.length - 1);
    const cum = { pass: data.map((d) => d.pass), review: data.map((d) => d.pass + d.review), block: totals };
    const pts = (arr) => arr.map((v, i) => [x(i), y(v)]);
    const zero = data.map(() => 0);
    const bands = [['pass', '--pass', zero, cum.pass], ['review', '--review', cum.pass, cum.review], ['block', '--block', cum.review, cum.block]];
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gate decisions per day for the last 7 days, stacked by decision"><defs>`;
    bands.forEach(([k, v]) => { s += `<linearGradient id="g-${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(${v});stop-opacity:.72"/><stop offset="1" style="stop-color:var(${v});stop-opacity:.16"/></linearGradient>`; });
    s += `<linearGradient id="fade-x" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".25"/><stop offset=".14" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient><mask id="m-fade"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#fade-x)"/></mask></defs>`;
    [0, 0.25, 0.5, 0.75, 1].forEach((fr) => { const v = Math.round(max * fr); s += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke-dasharray="2 6"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end">${v}</text>`; });
    s += '<g mask="url(#m-fade)">';
    bands.forEach(([k, v, lo, hi]) => {
      s += `<path d="${smoothPath(pts(hi), 'M')} ${smoothPath(pts(lo).reverse(), 'L')} Z" fill="url(#g-${k})"/>`;
      s += `<path d="${smoothPath(pts(hi), 'M')}" fill="none" style="stroke:var(${v})" stroke-width="1.6" stroke-linecap="round"/>`;
    });
    s += '</g>';
    const ex = x(6), ey = y(totals[6]);
    s += `<line x1="${ex}" x2="${ex}" y1="${ey}" y2="${y(0)}" style="stroke:var(--ink)" stroke-opacity=".16" stroke-dasharray="2 4"/>`;
    s += `<circle cx="${ex}" cy="${ey}" r="11" style="fill:var(--block)" fill-opacity=".14"/><circle cx="${ex}" cy="${ey}" r="4.5" style="fill:var(--surface);stroke:var(--block)" stroke-width="2"/>`;
    s += `<text x="${ex - 16}" y="${ey + 4}" text-anchor="end" style="fill:var(--ink);font-weight:600">${totals[6]} today</text>`;
    data.forEach((d, i) => {
      s += `<text x="${x(i)}" y="${H - 9}" text-anchor="${i === 0 ? 'start' : i === 6 ? 'end' : 'middle'}" style="${i === 6 ? 'fill:var(--ink);font-weight:600' : ''}">${d.label}</text>`;
      s += `<rect x="${x(i) - 22}" y="${T}" width="44" height="${H - T - B}" fill="transparent"><title>${esc(d.label)}: ${d.pass} passed, ${d.review} review, ${d.block} blocked</title></rect>`;
    });
    s += '</svg><div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px"><span class="chip sq c-pass">Passed</span><span class="chip sq c-review">Review</span><span class="chip sq c-block">Blocked</span></div>';
    $('#ov-chart').innerHTML = s;
  }

  function renderApprovalsPanel(open) {
    const list = (open || []).slice(0, 4);
    $('#ov-approvals').innerHTML = list.length ? list.map((a) => `
      <div class="row"><span class="t">${esc(a.tool || 'action')}</span><span class="r"><button class="btn" data-go="approvals">Review</button></span>
      <span class="s"><span class="mono">${esc(a.tool)}</span> · ${ago(new Date(a.createdAt).toISOString())}</span></div>`).join('')
      : '<p class="empty">Nothing is waiting on you.</p>';
    const navCount = $('#nav-approvals-count');
    if (navCount) {
      if (list.length || (open && open.length)) { navCount.hidden = false; navCount.textContent = String((open || []).length); }
      else navCount.hidden = true;
    }
  }

  function renderAgentsPanel(agentsSeen) {
    const entries = [...agentsSeen.entries()].sort((a, b) => new Date(b[1]) - new Date(a[1])).slice(0, 5);
    $('#ov-agents').innerHTML = entries.length ? entries.map(([id, seen]) => `
      <div class="row"><span class="t mono">${esc(id)}</span><span class="r"><span class="chip c-pass">Connected</span></span>
      <span class="s">last seen ${ago(seen)}</span></div>`).join('')
      : '<p class="empty">No agent identity has reached a gate yet in this window.</p>';
  }

  function renderRecent(items) {
    $('#ov-recent').innerHTML = items.length ? items.slice(0, 6).map((a) => {
      const decision = a.receipt ? a.receipt.decision : '';
      const cls = decision === 'block' ? 'c-block' : decision === 'review' ? 'c-review' : decision ? 'c-pass' : 'c-muted';
      return `<div class="row"><span class="t">${esc(a.action || a.eventType)}</span><span class="r"><span class="chip ${cls}">${esc(decision || a.eventType)}</span></span>
      <span class="s"><span class="mono">${esc(a.actor)}</span>${a.tool ? ` used <span class="mono">${esc(a.tool)}</span>` : ''} · ${ago(a.timestamp)}</span></div>`;
    }).join('') : '<p class="empty">No activity recorded yet.</p>';
  }

  async function load() {
    renderStatus('Loading…');
    const [decisionsResult, approvalsResult, activityResult, weekResult] = await Promise.all([
      Data.fetchGateDecisions({ windowMs: currentWindowMs }),
      Data.fetchOpenApprovals(),
      Data.fetchActivity({ limit: 6 }),
      currentWindowMs === 604800000 ? Promise.resolve(null) : Data.fetchGateDecisions({ windowMs: 604800000 }),
    ]);

    if (!decisionsResult.ok) {
      renderStatus(`Could not load gate decisions: ${decisionsResult.error?.message || decisionsResult.error?.code || 'unknown error'}`, true);
    } else {
      renderStatus('');
    }
    const bucketed = decisionsResult.ok ? bucketDecisions(decisionsResult.items) : { counts: { pass: 0, auto: 0, review: 0, block: 0 }, earliest: null, agentsSeen: new Map() };
    const openReviewCount = approvalsResult.ok ? approvalsResult.approvals.length : bucketed.counts.review;
    renderVerdict(bucketed.counts, openReviewCount, bucketed.earliest, decisionsResult.truncated);
    renderAgentsPanel(bucketed.agentsSeen);

    const weekItems = weekResult ? (weekResult.ok ? weekResult.items : []) : (decisionsResult.ok ? decisionsResult.items : []);
    renderChart(weekItems);

    if (approvalsResult.ok) renderApprovalsPanel(approvalsResult.approvals);
    else $('#ov-approvals').innerHTML = `<p class="empty">Could not load the approval queue.</p>`;

    if (activityResult.ok) renderRecent(activityResult.items);
    else $('#ov-recent').innerHTML = `<p class="empty">Could not load recent activity.</p>`;
  }

  $$('#ov-window [data-win]').forEach((btn) => btn.addEventListener('click', () => {
    currentWindowMs = Number(btn.dataset.win);
    $$('#ov-window [data-win]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    load();
  }));

  // ---------- emergency-stop integrity banner (#2591, operator-only) ----------
  // The check itself lives in the Errors view (control-room-app.js); this
  // view only shows its recorded result. The localStorage flag is set only by a verified violation response and
  // cleared only by a verified clean one; an unavailable answer (403/404 or
  // network) changes nothing -- unknown is not clean.
  const IBANNER_FLAG = 'huqan-integrity-flag';

  function readIntegrityFlag() {
    try {
      const parsed = JSON.parse(localStorage.getItem(IBANNER_FLAG) || 'null');
      if (parsed && parsed.workspaceId === Data.workspace() && parsed.seenAt) return parsed;
    } catch (_) { /* private browsing or corrupt flag: show no banner */ }
    return null;
  }

  function renderIntegrityBanner(flag) {
    const el = $('#ibanner');
    if (!el) return;
    if (!flag) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<b>Emergency-stop integrity violation</b> &mdash; agents stay halted.'
      + `<small>Recorded ${esc(new Date(flag.seenAt).toLocaleString())} in workspace <span class="mono">${esc(flag.workspaceId)}</span>.`
      + ' Clearing requires an operator lift; this banner does not clear itself.'
      + `${flag.reason ? ` Signal: <span class="mono">${esc(flag.reason)}</span>.` : ''}</small>`;
  }

  renderIntegrityBanner(readIntegrityFlag());

  window.addEventListener('huqan:integrity-flag', (e) => renderIntegrityBanner(e.detail));
  UI.registerView('overview', { onShow: load });
  window.HuqanControlRoomOverview = { reload: load };
})();
