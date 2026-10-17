'use strict';

// ---------- plain-language approval cards ----------
// Turns a raw approval row into the sentence a person reads. Pure, so the
// vocabulary is testable without a browser (test/control-room-approvals.test.js).

const AGENT_NAMES = Object.freeze({
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
  cline: 'Cline',
  opencode: 'opencode',
  cursor: 'Cursor',
  freebuff: 'Freebuff',
  'gemini-cli': 'Gemini CLI',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf',
  'http-api': 'An app using the HUQAN API',
  cli: 'The HUQAN command line',
  mcp: 'An MCP client',
});

// tool id -> [what the agent wants to do, short title prefix]
const TOOL_PHRASES = Object.freeze({
  'huqan.learn': ['wants to save to memory', 'Remember'],
  'huqan.fractal-learn': ['wants to save several connected facts to memory', 'Remember'],
  'huqan.experience_learn': ['wants to record what it learned from a task', 'Record experience'],
  'http.ingest': ['wants to import documents into memory', 'Import'],
  'huqan.ingest_execute': ['wants to import documents into memory', 'Import'],
  'huqan.agent': ['wants to run a multi-step task', 'Run task'],
  'huqan.self-evolve': ['wants to change how HUQAN reasons', 'Change reasoning'],
  'huqan.policy': ['wants to change a policy', 'Change policy'],
  'git.push': ['wants to push commits', 'Push'],
  'fs.write': ['wants to edit a file', 'Edit'],
  'email.send': ['wants to send email', 'Send'],
  'http.post': ['wants to call an outside service', 'Call'],
});

const POLICY_TEXT = Object.freeze({
  mutating_requires_review: 'Anything that changes what HUQAN remembers waits for a person.',
  unknown_tool_requires_review: 'HUQAN has not seen this tool before, so a person decides.',
  high_risk_requires_review: 'This action is marked high risk, so a person decides.',
  firewall_requires_review: 'This action touches a protected boundary, so a person decides.',
  ingest_requires_review: 'Imported documents wait for a person before they become memory.',
});

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return value && typeof value === 'object' ? value : {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch (_) { return {}; }
}

function agentName(id) {
  const key = String(id || '').trim();
  if (!key) return 'An agent';
  return AGENT_NAMES[key.toLowerCase()] || key;
}

function approvalActor(approval) {
  const context = approval.context || {};
  if (approval.origin && approval.origin.ref) return approval.origin.ref;
  if (context.agentId) return context.agentId;
  const provenance = context.provenance || (context.candidate && context.candidate.provenance) || {};
  if (provenance.agentId) return provenance.agentId;
  if (provenance.actor) return provenance.actor;
  const args = context.args || parseMaybeJson(approval.input);
  return (args.provenance && args.provenance.actor) || '';
}

function approvalSubject(approval) {
  const context = approval.context || {};
  const args = context.args || parseMaybeJson(approval.input);
  const docs = Array.isArray(args.documents) ? args.documents.length : 0;
  const text = (context.candidate && context.candidate.claim) || args.text || args.goal || args.title
    || (docs ? `${docs} document${docs === 1 ? '' : 's'}` : '');
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function evidenceCount(approval) {
  const context = approval.context || {};
  if (Array.isArray(context.evidence)) return context.evidence.length;
  let count = 0;
  if (context.provenance || (context.candidate && context.candidate.provenance)) count += 1;
  if (context.candidate && context.candidate.conflict) count += 1;
  return count;
}

function policyId(approval) {
  const gate = (approval.policy && approval.policy.gate) || {};
  return String(gate.policyId || gate.reason || approval.reason || '');
}

function describeApproval(approval) {
  const a = approval || {};
  const tool = String(a.tool || '');
  const [verb, titlePrefix] = TOOL_PHRASES[tool] || ['wants to run an action that needs a person', 'Action'];
  const actor = approvalActor(a);
  const who = agentName(actor);
  const subject = approvalSubject(a);
  const id = policyId(a);
  return {
    sentence: subject ? `${who} ${verb}: “${subject}”` : `${who} ${verb}.`,
    title: subject ? `${titlePrefix}: ${subject}` : titlePrefix,
    agent: who,
    agentId: actor || 'unknown',
    tool,
    evidence: evidenceCount(a),
    policyId: id,
    policyText: POLICY_TEXT[id] || 'Policy requires a person for this action.',
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { describeApproval, agentName, AGENT_NAMES, TOOL_PHRASES };

if (typeof window !== 'undefined') {
(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, $$, esc, ago, toast } = UI;

  let decidedThisSession = []; // { approval, decision, reason, decidedAt }
  let tab = 'open';
  let grant = { mode: 'ask', autoActive: false, autoAvailable: false, available: true };

  function getSessionApprovedCount() {
    return decidedThisSession.filter((d) => d.decision === 'approved').length;
  }
  const openList = () => Data.approvalQueue().approvals;
  const findOpen = (id) => openList().find((a) => a.id === id);

  function updateNavCount() {
    const navCount = $('#nav-approvals-count');
    if (!navCount) return;
    const n = openList().length;
    navCount.hidden = !n;
    navCount.textContent = String(n);
  }

  function metaLine(d, createdAt) {
    return `<span class="mono">${esc(d.agentId)}</span><span class="mono">${esc(d.tool)}</span><span>${ago(new Date(createdAt).toISOString())}</span><span>${d.evidence} evidence item${d.evidence === 1 ? '' : 's'}</span>`;
  }

  function openCard(a) {
    const d = describeApproval(a);
    return `
        <article class="ticket">
          <div>
            <h3>${esc(d.sentence)}</h3>
            <div class="meta">${metaLine(d, a.createdAt)}</div>
            <p class="why">${esc(d.policyText)}${d.policyId ? ` <span style="color:var(--soft)">(<span class="mono">${esc(d.policyId)}</span>)</span>` : ''}</p>
          </div>
          <div class="acts">
            <button class="btn" data-approval-open="${esc(a.id)}">Details</button>
            <button class="btn danger" data-decide="rejected" data-id="${esc(a.id)}" data-role-hide="viewer">Reject</button>
            <button class="btn primary" data-decide="approved" data-id="${esc(a.id)}" data-role-hide="viewer">Approve</button>
          </div>
        </article>`;
  }

  function doneCard(x) {
    const d = describeApproval(x.approval);
    return `
        <article class="ticket done">
          <div>
            <h3>${esc(d.sentence)}</h3>
            <div class="meta">${metaLine(d, x.approval.createdAt)}</div>
            <p class="why">${esc(x.reason || (x.decision === 'approved' ? 'Approved.' : 'Rejected without a reason.'))}</p>
          </div>
          <div class="acts"><span class="chip ${x.decision === 'approved' ? 'c-pass' : 'c-block'}">${x.decision === 'approved' ? 'Approved' : 'Rejected'}</span><span style="color:var(--soft);font-size:12.5px">${esc(ago(x.decidedAt))}</span></div>
        </article>`;
  }

  function renderQueue() {
    const items = tab === 'open' ? openList() : decidedThisSession;
    if (!items.length) {
      $('#appr-queue').innerHTML = `<p class="empty panel">${tab === 'open'
        ? 'Nothing is waiting. New requests appear here the moment an agent is paused.'
        : 'No decisions yet. Approve or reject something from Open.'}</p>`;
      return;
    }
    $('#appr-queue').innerHTML = tab === 'open' ? items.map(openCard).join('') : items.map(doneCard).join('');
  }

  // ---------- details drawer ----------
  function step(cls, mark, title, sub) {
    return `<li><span class="node ${cls}">${mark}</span><div><b>${esc(title)}</b><span>${sub}</span></div></li>`;
  }
  function openDetails(id) {
    const a = findOpen(id);
    if (!a) return;
    const d = describeApproval(a);
    const raw = { tool: a.tool, input: parseMaybeJson(a.input), policy: a.policy, context: a.context };
    UI.openDrawer(`
      <div class="drawer-head"><div><span class="chip c-review">Waiting</span><h2>${esc(d.title)}</h2></div><button class="btn" id="d-close" data-close aria-label="Close detail">Close</button></div>
      <p class="why">${esc(d.sentence)}</p>
      <dl class="kv">
        <dt>Agent</dt><dd>${esc(d.agent)}</dd>
        <dt>Tool</dt><dd class="mono">${esc(d.tool)}</dd>
        <dt>When</dt><dd>${esc(ago(new Date(a.createdAt).toISOString()))}</dd>
        <dt>Workspace</dt><dd class="mono">${esc(a.workspaceId)}</dd>
        <dt>Request ID</dt><dd class="mono">${esc(a.id)}</dd>
      </dl>
      <h3 style="font-size:14px">What HUQAN did</h3>
      <ol class="chain">
        ${step('c-muted', '1', 'Agent asked', `${esc(d.agent)} called <span class="mono">${esc(d.tool)}</span>`)}
        ${d.evidence ? step('c-pass', '✓', 'Evidence', `${d.evidence} source${d.evidence === 1 ? '' : 's'} attached to the request`) : step('c-block', '!', 'Evidence', 'No source attached')}
        ${step('c-review', '…', 'Policy: needs a person', `${esc(d.policyText)}${d.policyId ? ` <span class="mono">${esc(d.policyId)}</span>` : ''}`)}
        ${step('c-review', '…', 'Approval', 'Waiting for your decision')}
        ${step('c-review', '…', 'Receipt', 'Sealed once a person decides')}
      </ol>
      <div class="drawer-acts" data-role-hide="viewer"><button class="btn danger" data-decide="rejected" data-id="${esc(a.id)}">Reject</button><button class="btn primary" data-decide="approved" data-id="${esc(a.id)}">Approve</button></div>
      <details class="raw"><summary>Raw request</summary><pre class="mono"></pre></details>`);
    // Request content is agent-supplied: written through textContent only.
    $('#drawer pre').textContent = JSON.stringify(raw, null, 2);
  }

  // ---------- decision dialog ----------
  // Asks for operator approval at the moment of the decision. Nothing typed
  // here is stored: the key is sent once to mint a one-use grant.
  let pending = null; // { id, decision, purpose }

  function openDialog({ id, decision, purpose = 'decide', message = '', forceKey = false }) {
    pending = { id, decision, purpose };
    const a = id ? findOpen(id) : null;
    const d = a ? describeApproval(a) : null;
    const askKey = forceKey || purpose === 'enable-auto' || !grant.autoActive;
    $('#dd-title').textContent = purpose === 'enable-auto'
      ? 'Approve without asking on this computer?'
      : decision === 'approved' ? 'Approve this action?' : 'Reject this action?';
    $('#dd-summary').textContent = purpose === 'enable-auto'
      ? 'HUQAN will stop asking for the operator key when you approve from this computer. It never applies to other computers, and you can turn it off in Customize.'
      : d ? d.sentence : '';
    $('#dd-reason-field').hidden = !(purpose === 'decide' && decision === 'rejected');
    $('#dd-key-field').hidden = !askKey;
    $('#dd-reason').value = '';
    $('#dd-key').value = '';
    $('#dd-error').textContent = message;
    const confirm = $('#dd-confirm');
    confirm.textContent = purpose === 'enable-auto' ? 'Turn on' : decision === 'approved' ? 'Approve' : 'Reject';
    confirm.className = `btn ${decision === 'rejected' ? 'danger' : 'primary'}`;
    confirm.disabled = false;
    $('#decide-dialog').hidden = false;
    $('#scrim').classList.add('on');
    (askKey ? $('#dd-key') : (decision === 'rejected' ? $('#dd-reason') : confirm)).focus();
  }

  function closeDialog() {
    pending = null;
    $('#dd-key').value = '';
    $('#decide-dialog').hidden = true;
    if (!$('#drawer').classList.contains('on')) $('#scrim').classList.remove('on');
  }

  function explain(error) {
    if (!error) return 'Something went wrong. Nothing was changed.';
    if (error.code === 'OPERATOR_AUTH_REQUIRED') return 'That operator key was not accepted. Nothing was changed.';
    if (error.code === 'APPROVAL_NOT_FOUND') return 'This request is no longer waiting. It may have expired or been decided elsewhere.';
    return error.message || 'Something went wrong. Nothing was changed.';
  }

  async function submitDecision(id, decision, reason, operatorKey) {
    const approval = findOpen(id);
    const result = await Data.decideApproval(id, decision, reason, { operatorKey });
    if (!result.ok) return result;
    decidedThisSession = [{ approval: approval || { id, tool: '' }, decision, reason, decidedAt: new Date().toISOString() }, ...decidedThisSession];
    UI.closeDrawer();
    toast(decision === 'approved' ? 'Approved. The action can now run and its receipt is sealed.' : 'Rejected. The action will not run.');
    renderQueue();
    return result;
  }

  async function confirmDialog() {
    if (!pending) return;
    const { id, decision, purpose } = pending;
    const operatorKey = $('#dd-key-field').hidden ? '' : $('#dd-key').value;
    const reason = $('#dd-reason').value.trim();
    $('#dd-confirm').disabled = true;
    $('#dd-error').textContent = '';
    const result = purpose === 'enable-auto'
      ? await Data.setGrantMode('auto', operatorKey)
      : await submitDecision(id, decision, reason, operatorKey);
    $('#dd-key').value = '';
    if (!result.ok) {
      $('#dd-confirm').disabled = false;
      $('#dd-error').textContent = explain(result.error);
      return;
    }
    if (purpose === 'enable-auto') toast('Automatic approval is on for this computer.');
    closeDialog();
  }

  function setBusy(id, busy) {
    $$('[data-decide]').filter((b) => b.dataset.id === id).forEach((b) => { b.disabled = busy; });
  }

  async function decide(id, decision) {
    if (decision === 'approved' && grant.autoActive) {
      setBusy(id, true);
      const result = await submitDecision(id, decision, '', '');
      setBusy(id, false);
      // A refused automatic approval must leave the retry open: show the key
      // field whenever the grant answered that operator authority is needed.
      if (!result.ok) openDialog({ id, decision, message: explain(result.error), forceKey: result.needsOperator === true });
      return;
    }
    openDialog({ id, decision });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-decide]');
    if (b && !b.disabled) { decide(b.dataset.id, b.dataset.decide); return; }
    const details = e.target.closest('[data-approval-open]');
    if (details) { openDetails(details.dataset.approvalOpen); return; }
    if (e.target.closest('#dd-cancel') || (e.target.id === 'scrim' && pending)) closeDialog();
  });
  $('#decide-form')?.addEventListener('submit', (e) => { e.preventDefault(); confirmDialog(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pending) closeDialog(); });

  // ---------- automatic approval setting (Customize) ----------
  function renderGrant() {
    const on = grant.autoActive === true;
    $$('[data-auto-indicator]').forEach((el) => { el.hidden = !on; });
    const toggle = $('#auto-approve');
    if (toggle) {
      toggle.checked = on;
      toggle.disabled = !grant.available || (!grant.autoAvailable && !on);
    }
    const note = $('#auto-approve-note');
    if (note) {
      note.textContent = !grant.available
        ? 'Approving from this screen is not set up on this server.'
        : !grant.autoAvailable
          ? 'Only available when the Control Room is opened on the computer running HUQAN.'
          : on ? 'On. Approvals you make here go through without asking for the operator key.'
            : 'Off. Every approval asks for the operator key.';
    }
  }

  async function loadGrant() {
    const result = await Data.fetchGrant();
    grant = result.ok
      ? { mode: result.mode, autoActive: result.autoActive === true, autoAvailable: result.autoAvailable === true, available: true }
      : { mode: 'ask', autoActive: false, autoAvailable: false, available: result.available !== false };
    renderGrant();
  }

  $('#auto-approve')?.addEventListener('change', async (e) => {
    if (e.target.checked) {
      e.target.checked = false;
      openDialog({ purpose: 'enable-auto', decision: 'approved' });
      return;
    }
    const result = await Data.setGrantMode('ask');
    if (!result.ok) toast(explain(result.error));
    else toast('Automatic approval is off. Every approval asks again.');
  });
  window.addEventListener('huqan:grant-changed', (e) => {
    const detail = e.detail || {};
    grant = { ...grant, mode: detail.mode, autoActive: detail.autoActive === true, autoAvailable: detail.autoAvailable === true };
    renderGrant();
  });

  $$('#appr-tabs [data-qfilter]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.qfilter;
    $$('#appr-tabs [data-qfilter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderQueue();
  }));

  window.addEventListener('huqan:approvals-changed', () => {
    updateNavCount();
    if (!$('[data-view="approvals"]').hidden) renderQueue();
  });

  async function load() {
    $('#appr-status').textContent = '';
    $('#appr-status').className = 'status';
    const result = await Data.fetchOpenApprovals();
    if (!result.ok) {
      $('#appr-status').textContent = `Could not load approvals: ${result.error?.message || result.error?.code || 'unknown error'}`;
      $('#appr-status').className = 'status bad';
      return;
    }
    renderQueue();
  }

  $('#appr-refresh')?.addEventListener('click', load);
  UI.registerView('approvals', { onShow: load });
  loadGrant();
  window.HuqanControlRoomApprovals = { getSessionApprovedCount, reload: load };
})();
}
