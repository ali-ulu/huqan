'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const apiHeaders = () => {
    const key = sessionStorage.getItem('huqan-api-key') || '';
    return { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  };
  const workspaceId = () => sessionStorage.getItem('huqan-workspace') || 'default';

  function setStatus(message, tone = '') {
    const element = byId('ingestrunstatus');
    element.textContent = message;
    element.className = `status ${tone}`;
  }

  function renderRun(run) {
    const manifest = run.sourceManifest || {};
    const progress = run.progress || {};
    const retry = run.retry || {};
    const resume = run.resume || {};
    const rows = [
      ['Status', run.status || 'unknown'],
      ['Phase', run.phase || '—'],
      ['Run ID', run.runId || '—'],
      ['Approval', run.approvalId || '—'],
      ['Workspace', manifest.workspaceId || workspaceId()],
      ['Source', `${manifest.sourceType || '—'} · ${manifest.sourceRef || '—'}`],
      ['Digest', manifest.sourceDigest || '—'],
      ['Idempotency key', manifest.idempotencyKey || '—'],
      ['Progress', `${progress.completed ?? '—'} / ${progress.total ?? '—'}`],
      ['Next action', run.nextAction || 'none'],
      ['Retry', retry.allowed ? 'allowed' : retry.reason || 'not allowed'],
      ['Resume', resume.allowed ? 'allowed' : resume.reason || 'not allowed'],
      ['Receipt', run.receiptId || 'not emitted'],
    ];
    byId('ingestrunsummary').innerHTML = rows
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')
      + (run.receiptId
        ? `<dt>Evidence</dt><dd><button class="btn" type="button" data-ingest-receipt="${escapeHtml(run.receiptId)}">Open receipt</button></dd>`
        : '');
    byId('ingestrunraw').textContent = JSON.stringify(run, null, 2);
    const tone = run.status === 'completed' ? 'good'
      : ['failed', 'blocked'].includes(run.status) ? 'bad' : '';
    setStatus(`${run.status || 'unknown'} · ${run.phase || 'phase unknown'}`, tone);
  }

  async function workflowCapability() {
    const response = await fetch('/api/v2/workflows', { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(body.workflows)) throw new Error('capability_manifest_unavailable');
    const capability = body.workflows.find(item => item.workflowId === 'ingest-run-detail');
    if (!capability?.availability?.ui) throw new Error('capability_not_available');
    if (capability.method !== 'GET' || !capability.route?.includes('{id}')) throw new Error('route_template_unsupported');
    return capability;
  }

  async function loadRun() {
    const runId = byId('ingestrunid').value.trim();
    if (!runId) return setStatus('Enter a run ID.', 'bad');
    setStatus('Loading ingest run…');
    try {
      const capability = await workflowCapability();
      const route = capability.route.replace('{id}', encodeURIComponent(runId));
      const query = new URLSearchParams({ workspaceId: workspaceId() });
      const response = await fetch(`${route}?${query}`, { headers: apiHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error?.code || body.error?.message || `HTTP ${response.status}`);
      if (!body.data || body.data.workflowId !== 'ingest-run-detail') throw new Error('ingest_run_projection_missing');
      renderRun(body.data);
    } catch (error) {
      byId('ingestrunsummary').innerHTML = '<dt>Status</dt><dd>—</dd>';
      byId('ingestrunraw').textContent = '—';
      setStatus(`failed: ${error.message}`, 'bad');
    }
  }

  function openRun(runId) {
    byId('ingestrunid').value = runId;
    document.querySelector('[data-v="ingest-run"]').click();
    loadRun();
  }

  const nav = document.querySelector('.nav');
  const approvals = nav.querySelector('[data-v="approvals"]');
  const button = document.createElement('button');
  button.dataset.v = 'ingest-run';
  button.setAttribute('aria-label', 'Ingest Runs');
  button.innerHTML = '<i class="ico" aria-hidden="true">↻</i><span class="copy"><b>Ingest Runs</b><span>Progress & Receipts</span></span>';
  approvals.parentElement.insertBefore(button, approvals);
  button.onclick = () => window.go('ingest-run');

  byId('ingestrunload').onclick = loadRun;
  byId('ingestrunid').onkeydown = event => { if (event.key === 'Enter') loadRun(); };
  document.addEventListener('click', event => {
    const runButton = event.target.closest('[data-ingest-run]');
    if (runButton) openRun(runButton.dataset.ingestRun);
    const receiptButton = event.target.closest('[data-ingest-receipt]');
    if (receiptButton) {
      byId('einput').value = receiptButton.dataset.ingestReceipt;
      byId('emode').value = 'receiptId';
      document.querySelector('[data-v="evidence"]').click();
      byId('eload').click();
    }
  });

  const result = byId('result');
  new MutationObserver(() => {
    if (result.querySelector('[data-ingest-run]')) return;
    const raw = result.querySelector('pre.json')?.textContent;
    if (!raw) return;
    try {
      const body = JSON.parse(raw);
      const runId = body?.data?.runId;
      if (!runId) return;
      const handoff = document.createElement('div');
      handoff.className = 'actions';
      handoff.innerHTML = `<button class="btn" type="button" data-ingest-run="${escapeHtml(runId)}">View ingest run</button>`;
      result.prepend(handoff);
    } catch (_) {}
  }).observe(result, { childList: true, subtree: true });
})();
