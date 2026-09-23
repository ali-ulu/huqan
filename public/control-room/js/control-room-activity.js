'use strict';

(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, $$, esc, ago } = UI;

  let items = [];
  let nextCursor = null;
  let loaded = false;

  function decisionLabel(decision) {
    return { allow: 'Passed', review: 'Waiting', block: 'Blocked' }[decision] || (decision || 'unattributed');
  }
  function decisionClass(decision) {
    return { allow: 'c-pass', review: 'c-review', block: 'c-block' }[decision] || 'c-muted';
  }

  function currentFilter() {
    return {
      q: ($('#act-q').value || '').trim().toLowerCase(),
      agent: $('#act-agent').value,
      tool: $('#act-tool').value,
      verdict: $('#act-verdict').value,
    };
  }

  function fillFilterOptions() {
    const agentSel = $('#act-agent');
    const toolSel = $('#act-tool');
    // A saved view may have chosen an agent or tool before this page loaded;
    // keep that choice across the refill.
    const chosen = { agent: agentSel.value, tool: toolSel.value };
    const keepFirst = (sel) => { while (sel.options.length > 1) sel.remove(1); };
    keepFirst(agentSel); keepFirst(toolSel);
    const agents = new Set(); const tools = new Set();
    items.forEach((it) => { if (it.actor) agents.add(it.actor); if (it.tool) tools.add(it.tool); });
    if (chosen.agent) agents.add(chosen.agent);
    if (chosen.tool) tools.add(chosen.tool);
    [...agents].sort().forEach((a) => agentSel.insertAdjacentHTML('beforeend', `<option>${esc(a)}</option>`));
    [...tools].sort().forEach((t) => toolSel.insertAdjacentHTML('beforeend', `<option>${esc(t)}</option>`));
    agentSel.value = chosen.agent;
    toolSel.value = chosen.tool;
  }

  function render() {
    const f = currentFilter();
    const rows = items.filter((it) => {
      if (f.agent && it.actor !== f.agent) return false;
      if (f.tool && it.tool !== f.tool) return false;
      if (f.verdict && (!it.receipt || it.receipt.decision !== f.verdict)) return false;
      if (f.q) {
        const hay = `${it.action} ${it.tool} ${it.actor} ${it.receipt ? it.receipt.receiptId : ''}`.toLowerCase();
        if (!hay.includes(f.q)) return false;
      }
      return true;
    });
    $('#act-count').textContent = `${rows.length} of ${items.length} loaded actions`;
    $('#act-body').innerHTML = rows.length ? rows.map((it) => {
      const decision = it.receipt ? it.receipt.decision : '';
      return `<tr data-open="${esc(it.auditId)}" tabindex="0">
        <td class="num" style="white-space:nowrap;color:var(--soft)">${ago(it.timestamp)}</td>
        <td class="mono">${esc(it.actor)}</td>
        <td class="mono">${esc(it.tool || '—')}</td>
        <td class="what">${esc(it.action || it.eventType)}<span class="sub">event: <span class="mono">${esc(it.eventType)}</span></span></td>
        <td><span class="chip ${decisionClass(decision)}">${esc(decisionLabel(decision))}</span></td>
        <td class="mono" style="color:var(--soft)">${it.receipt && it.receipt.receiptId ? esc(it.receipt.receiptId) : '<span>unattributed</span>'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">No actions match these filters, or nothing has loaded yet.</td></tr>';
  }

  function openRow(auditId) {
    const it = items.find((x) => x.auditId === auditId);
    if (!it) return;
    const r = it.receipt;
    const step = (cls, mark, title, sub) => `<li><span class="node ${cls}">${mark}</span><div><b>${title}</b><span>${sub}</span></div></li>`;
    const chain = [step('c-muted', '1', 'Agent asked', `<span class="mono">${esc(it.actor)}</span> triggered <span class="mono">${esc(it.eventType)}</span>${it.tool ? ` via <span class="mono">${esc(it.tool)}</span>` : ''}`)];
    if (r) {
      const cls = decisionClass(r.decision);
      chain.push(step(cls, r.decision === 'block' ? '✕' : r.decision === 'review' ? '…' : '✓', `Policy: ${esc(decisionLabel(r.decision))}`, esc(r.reason || 'no reason recorded')));
      chain.push(r.receiptId
        ? step('c-pass', '✓', 'Receipt', `<span class="mono">${esc(r.receiptId)}</span>`)
        : step('c-muted', '–', 'Receipt', 'No receipt attached to this event'));
    } else {
      chain.push(step('c-muted', '–', 'Decision', 'unattributed — no receipt found for this event'));
    }
    UI.openDrawer(`
      <div class="drawer-head"><div><h2>${esc(it.action || it.eventType)}</h2></div><button class="btn" id="d-close" data-close aria-label="Close detail">Close</button></div>
      <dl class="kv">
        <dt>Actor</dt><dd class="mono">${esc(it.actor)}</dd>
        <dt>Tool</dt><dd class="mono">${esc(it.tool || '—')}</dd>
        <dt>When</dt><dd>${new Date(it.timestamp).toLocaleString()}</dd>
        <dt>Audit ID</dt><dd class="mono">${esc(it.auditId)}</dd>
        <dt>Trace</dt><dd class="mono">${esc(it.traceId || '—')}</dd>
      </dl>
      <h3 style="font-size:14px">What HUQAN recorded</h3>
      <ol class="chain">${chain.join('')}</ol>
    `);
  }

  document.addEventListener('click', (e) => {
    const row = e.target.closest('#act-body [data-open]');
    if (row) openRow(row.dataset.open);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#act-body tr[data-open]')) openRow(e.target.dataset.open);
  });

  async function loadPage(reset) {
    if (reset) { items = []; nextCursor = null; }
    $('#act-status').textContent = 'Loading…';
    $('#act-status').className = 'status';
    const result = await Data.fetchActivity({ limit: 50, cursor: nextCursor || undefined });
    if (!result.ok) {
      $('#act-status').textContent = `Could not load activity: ${result.error?.message || result.error?.code || 'unknown error'}`;
      $('#act-status').className = 'status bad';
      return;
    }
    items = items.concat(result.items);
    nextCursor = result.hasMore ? result.nextCursor : null;
    $('#act-more').hidden = !nextCursor;
    $('#act-status').textContent = loaded ? '' : (items.length ? '' : 'No activity recorded yet.');
    loaded = true;
    fillFilterOptions();
    render();
  }

  ['#act-q', '#act-agent', '#act-tool', '#act-verdict'].forEach((sel) => {
    $(sel)?.addEventListener('input', render);
  });
  $('#act-refresh')?.addEventListener('click', () => loadPage(true));
  $('#act-more')?.addEventListener('click', () => loadPage(false));

  UI.registerView('activity', { onShow: () => loadPage(true) });
})();
