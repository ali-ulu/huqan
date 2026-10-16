'use strict';

(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, $$, esc, ago, toast } = UI;

  let open = [];
  let decidedThisSession = []; // { approval, decision, reason, decidedAt }
  let tab = 'open';

  function getSessionApprovedCount() {
    return decidedThisSession.filter((d) => d.decision === 'approved').length;
  }

  function inputSummary(input) {
    if (!input) return 'no input recorded';
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }

  function renderQueue() {
    const status = $('#appr-status');
    status.textContent = '';
    status.className = 'status';
    const items = tab === 'open' ? open : decidedThisSession;
    if (!items.length) {
      $('#appr-queue').innerHTML = `<p class="empty panel">${tab === 'open'
        ? 'Nothing is waiting. New requests appear here the moment an agent is paused.'
        : 'No decisions made in this browser session yet.'}</p>`;
      return;
    }
    if (tab === 'open') {
      $('#appr-queue').innerHTML = items.map((a) => `
        <article class="ticket">
          <div>
            <h3>${esc(a.tool || 'action')}</h3>
            <div class="meta"><span class="mono">${esc(a.tool)}</span><span>${ago(new Date(a.createdAt).toISOString())}</span><span>workspace: <span class="mono">${esc(a.workspaceId)}</span></span>${a.origin && a.origin.kind === 'external-agent' ? `<span class="chip sq c-review">source: external agent <span class="mono">${esc(a.origin.ref || 'unknown')}</span></span>` : ''}</div>
            <p class="why">${esc(a.reason || 'Policy requires a person for this action.')}</p>
            <p class="why" style="color:var(--soft)">${esc(inputSummary(a.input))}</p>
          </div>
          <div class="acts" data-role-hide="viewer">
            <button class="btn danger" data-decide="rejected" data-id="${esc(a.id)}">Reject</button>
            <button class="btn primary" data-decide="approved" data-id="${esc(a.id)}">Approve</button>
          </div>
        </article>`).join('');
    } else {
      $('#appr-queue').innerHTML = items.map((d) => `
        <article class="ticket done">
          <div>
            <h3>${esc(d.approval.tool || 'action')}</h3>
            <div class="meta"><span class="mono">${esc(d.approval.tool)}</span><span>${ago(d.decidedAt)}</span></div>
            <p class="why">${esc(d.reason || 'no reason given')}</p>
          </div>
          <div class="acts"><span class="chip ${d.decision === 'approved' ? 'c-pass' : 'c-block'}">${d.decision === 'approved' ? 'Approved' : 'Rejected'}</span></div>
        </article>`).join('');
    }
  }

  async function decide(id, decision) {
    const approval = open.find((a) => a.id === id);
    const reason = decision === 'rejected' ? (window.prompt('Reason for rejecting? (shown in the record)') || '') : '';
    if (decision === 'rejected' && reason === null) return;
    const buttons = $$(`[data-id="${id}"]`);
    buttons.forEach((b) => { b.disabled = true; });
    const result = await Data.decideApproval(id, decision, reason);
    buttons.forEach((b) => { b.disabled = false; });
    if (!result.ok) {
      toast(`Could not record decision: ${result.error?.message || result.error?.code || 'unknown error'}`);
      return;
    }
    open = open.filter((a) => a.id !== id);
    decidedThisSession = [{ approval: approval || { id, tool: '' }, decision, reason, decidedAt: new Date().toISOString() }, ...decidedThisSession];
    const navCount = $('#nav-approvals-count');
    if (navCount) { if (open.length) { navCount.hidden = false; navCount.textContent = String(open.length); } else navCount.hidden = true; }
    toast(decision === 'approved' ? 'Approved. The action can now run and its receipt is sealed.' : 'Rejected. The action will not run.');
    renderQueue();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-decide]');
    if (b && !b.disabled) decide(b.dataset.id, b.dataset.decide);
  });

  $$('#appr-tabs [data-qfilter]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.qfilter;
    $$('#appr-tabs [data-qfilter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderQueue();
  }));

  async function load() {
    $('#appr-status').textContent = 'Loading…';
    $('#appr-status').className = 'status';
    const result = await Data.fetchOpenApprovals();
    if (!result.ok) {
      $('#appr-status').textContent = `Could not load approvals: ${result.error?.message || result.error?.code || 'unknown error'}`;
      $('#appr-status').className = 'status bad';
      return;
    }
    open = result.approvals;
    const navCount = $('#nav-approvals-count');
    if (navCount) { if (open.length) { navCount.hidden = false; navCount.textContent = String(open.length); } else navCount.hidden = true; }
    renderQueue();
  }

  $('#appr-refresh')?.addEventListener('click', load);
  UI.registerView('approvals', { onShow: load });
  window.HuqanControlRoomApprovals = { getSessionApprovedCount, reload: load };
})();
