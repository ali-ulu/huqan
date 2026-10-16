'use strict';

(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, esc, ago } = UI;

  let rows = []; // { auditId, receiptId, action, tool, actor, decision, state }
  let nextCursor = null;
  const verifyCache = new Map(); // receiptId -> 'verified' | 'unverifiable'

  function stateChip(state) {
    return {
      verified: '<span class="chip c-pass">Verified</span>',
      pending: '<span class="chip c-review">Awaiting approval</span>',
      unverifiable: '<span class="chip c-err">Unverifiable</span>',
      checking: '<span class="chip c-muted">Checking…</span>',
    }[state] || '<span class="chip c-muted">Unknown</span>';
  }

  function renderCounts() {
    const counts = { verified: 0, pending: 0, unverifiable: 0 };
    rows.forEach((r) => { if (counts[r.state] !== undefined) counts[r.state] += 1; });
    $('#rcpt-verified').textContent = counts.verified;
    $('#rcpt-pending').textContent = counts.pending;
    $('#rcpt-bad').textContent = counts.unverifiable;
  }

  function render() {
    const filter = $('#rcpt-filter').value;
    const filtered = filter ? rows.filter((r) => r.state === filter) : rows;
    $('#rcpt-count').textContent = `${filtered.length} of ${rows.length} loaded receipts`;
    $('#rcpt-body').innerHTML = filtered.length ? filtered.map((r) => `
      <tr data-audit="${esc(r.auditId)}"><td class="mono">${esc(r.receiptId)}</td>
      <td class="what">${esc(r.action)}<span class="sub mono">${esc(r.actor)} · ${esc(r.tool || '—')}</span></td>
      <td>${esc(r.decision || '—')}</td><td>${esc(r.actor)}</td><td>${stateChip(r.state)}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">No receipts match this filter.</td></tr>';
    renderCounts();
  }

  async function verifyRow(row) {
    if (!row.receiptId) { row.state = 'unverifiable'; render(); return; }
    if (row.decision === 'review') { row.state = 'pending'; render(); return; }
    if (verifyCache.has(row.receiptId)) { row.state = verifyCache.get(row.receiptId); render(); return; }
    row.state = 'checking';
    const result = await Data.fetchReceipt(row.receiptId);
    const state = result.ok && result.receipt ? 'verified' : 'unverifiable';
    verifyCache.set(row.receiptId, state);
    row.state = state;
    render();
  }

  async function loadPage(reset) {
    if (reset) { rows = []; nextCursor = null; }
    $('#rcpt-status').textContent = 'Loading…';
    $('#rcpt-status').className = 'status';
    const result = await Data.fetchActivity({ limit: 50, cursor: nextCursor || undefined });
    if (!result.ok) {
      $('#rcpt-status').textContent = `Could not load receipts: ${result.error?.message || result.error?.code || 'unknown error'}`;
      $('#rcpt-status').className = 'status bad';
      return;
    }
    const newRows = result.items.filter((it) => it.receipt && it.receipt.receiptId).map((it) => ({
      auditId: it.auditId,
      receiptId: it.receipt.receiptId,
      action: it.action || it.eventType,
      tool: it.tool,
      actor: it.actor,
      decision: it.receipt.decision,
      state: 'checking',
    }));
    rows = rows.concat(newRows);
    nextCursor = result.hasMore ? result.nextCursor : null;
    $('#rcpt-more').hidden = !nextCursor;
    $('#rcpt-status').textContent = rows.length ? '' : 'No receipts found in the loaded activity window.';
    render();
    // Bounded, sequential verification: never more than the loaded page, and
    // one at a time so this never turns into a burst against the receipt API.
    for (const row of newRows) {
      // eslint-disable-next-line no-await-in-loop
      await verifyRow(row);
    }
  }

  $('#rcpt-filter')?.addEventListener('change', render);
  $('#rcpt-refresh')?.addEventListener('click', () => loadPage(true));
  $('#rcpt-more')?.addEventListener('click', () => loadPage(false));

  UI.registerView('receipts', { onShow: () => loadPage(true) });
})();
