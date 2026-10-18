'use strict';

// Agents: the registry of agents the user added, whether each is connected,
// and the agents HUQAN found on this computer. Discovery only suggests; an
// agent joins the registry when the user ticks it and presses Add.

const AGENT_STATUS = Object.freeze({
  connected: ['c-pass', 'Connected'],
  disconnected: ['c-block', 'Disconnected'],
  not_connected: ['c-muted', 'Not connected'],
});

/** The line under an agent card, in plain language. */
function agentFootnote(agent, ago) {
  if (agent.status === 'connected') return `Last seen ${ago(agent.lastSeen)}`;
  if (agent.status === 'disconnected') return `Last seen ${ago(agent.lastSeen)}. Its actions are <b>not being watched</b> right now.`;
  return 'Added, but it has not sent anything through HUQAN yet.';
}

/** What a discovery row says about one agent found on this computer. */
function discoveryState(found) {
  if (found.registered) return 'Already added';
  if (found.huqanConfigured) return 'HUQAN is in its settings';
  if (found.installed) return 'Installed, HUQAN is not in its settings yet';
  return 'Not found on this computer';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { AGENT_STATUS, agentFootnote, discoveryState };

if (typeof window !== 'undefined') {
(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, $$, esc, ago, toast } = UI;

  let registry = { agents: [], seenUnregistered: [] };
  let found = [];
  let offeredDiscovery = false;

  const chip = (status) => {
    const [cls, label] = AGENT_STATUS[status] || AGENT_STATUS.not_connected;
    return `<span class="chip ${cls}">${label}</span>`;
  };

  function countsFor(id, decisions) {
    const c = { total: 0, waiting: 0, blocked: 0 };
    (decisions || []).forEach((item) => {
      if (item.agentId !== id) return;
      c.total += 1;
      const status = String(item.status || '').toLowerCase();
      if (status === 'block') c.blocked += 1;
      if (status === 'review') c.waiting += 1;
    });
    return c;
  }

  function renderCards(decisions) {
    const list = registry.agents;
    if (!list.length) {
      $('#agents-list').innerHTML = '<p class="empty panel">No agents added yet. Press “Find agents” to see which ones are on this computer.</p>';
      return;
    }
    const order = { connected: 0, disconnected: 1, not_connected: 2 };
    $('#agents-list').innerHTML = [...list].sort((a, b) => order[a.status] - order[b.status]).map((a) => {
      const c = countsFor(a.id, decisions);
      return `
      <article class="agent">
        <div class="agent-top"><div><h3>${esc(a.id)}</h3><div class="kind">${esc(a.kind)}</div></div>${chip(a.status)}</div>
        <dl><div><dt>Actions</dt><dd class="num">${c.total}</dd></div><div><dt>Waiting</dt><dd class="num">${c.waiting}</dd></div><div><dt>Blocked</dt><dd class="num">${c.blocked}</dd></div></dl>
        <div class="foot">${agentFootnote(a, ago)} <button class="link agent-remove" data-agent-remove="${esc(a.id)}" data-role-hide="viewer approver">Remove</button></div>
      </article>`;
    }).join('');
  }

  function renderDiscovery() {
    const panel = $('#agents-found');
    const candidates = found.filter((f) => f.installed || f.registered);
    if (!candidates.length) {
      panel.innerHTML = '<p class="empty">HUQAN did not find any supported agent on this computer.</p>';
      return;
    }
    panel.innerHTML = `
      <div class="panel-head"><h2>Found on this computer</h2><span class="hint">Tick the agents HUQAN should watch</span></div>
      <ul class="found-list">${candidates.map((f) => `
        <li><label for="found-${esc(f.id)}"><input type="checkbox" id="found-${esc(f.id)}" data-found="${esc(f.id)}" ${f.registered ? 'checked disabled' : (f.huqanConfigured ? 'checked' : '')}>
          <span><b>${esc(f.name)}</b><small>${esc(f.kind)} · ${esc(discoveryState(f))}</small></span></label></li>`).join('')}
      </ul>
      <p class="found-note">Adding an agent only adds it to this list. HUQAN never changes an agent's own settings.</p>
      <div class="found-acts"><button class="btn" type="button" id="agents-found-close">Not now</button><button class="btn primary" type="button" id="agents-add">Add selected</button></div>`;
  }

  async function openDiscovery() {
    const panel = $('#agents-found');
    panel.hidden = false;
    panel.innerHTML = '<p class="empty">Looking for agents on this computer…</p>';
    const result = await Data.discoverAgents();
    if (!result.ok) {
      panel.innerHTML = `<p class="empty">${result.error?.code === 'AGENT_REGISTRY_LOCAL_ONLY'
        ? 'Agents can only be found from the computer running HUQAN.'
        : 'HUQAN could not look for agents right now.'}</p>`;
      return;
    }
    found = result.agents;
    renderDiscovery();
  }

  async function addSelected() {
    const ids = $$('#agents-found [data-found]').filter((b) => b.checked && !b.disabled).map((b) => b.dataset.found);
    if (!ids.length) { toast('Tick at least one agent first.'); return; }
    for (const id of ids) {
      const result = await Data.registerAgent(id);
      if (!result.ok) { toast(`Could not add ${id}.`); return; }
      registry = { agents: result.agents || [], seenUnregistered: result.seenUnregistered || [] };
    }
    $('#agents-found').hidden = true;
    toast(ids.length === 1 ? 'Agent added.' : `${ids.length} agents added.`);
    load();
  }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('#agents-find')) { openDiscovery(); return; }
    if (e.target.closest('#agents-add')) { addSelected(); return; }
    if (e.target.closest('#agents-found-close')) { $('#agents-found').hidden = true; return; }
    const remove = e.target.closest('[data-agent-remove]');
    if (remove) {
      const result = await Data.removeAgent(remove.dataset.agentRemove);
      if (result.ok) { toast('Removed from the list. The agent itself was not changed.'); load(); }
      else toast('Could not remove it.');
    }
  });

  async function refreshRegistry() {
    const result = await Data.fetchAgents();
    if (result.ok) registry = { agents: result.agents || [], seenUnregistered: result.seenUnregistered || [] };
    return result;
  }

  // Overview's "Connected agents" panel reads the same registry.
  async function renderOverviewPanel() {
    const result = await refreshRegistry();
    const el = $('#ov-agents');
    if (!result.ok) { el.innerHTML = '<p class="empty">Could not load agents.</p>'; return; }
    el.innerHTML = registry.agents.length ? registry.agents.slice(0, 6).map((a) => `
      <div class="row"><span class="t mono">${esc(a.id)}</span><span class="r">${chip(a.status)}</span>
      <span class="s">${esc(a.kind)} · ${a.lastSeen ? `last seen ${esc(ago(a.lastSeen))}` : 'never seen'}</span></div>`).join('')
      : '<p class="empty">No agents added yet. <button class="link" data-go="agents">Find agents</button></p>';
  }

  async function load() {
    $('#agents-status').textContent = '';
    $('#agents-status').className = 'status';
    const [result, decisions] = await Promise.all([refreshRegistry(), Data.fetchGateDecisions({ windowMs: 86400000 })]);
    if (!result.ok) {
      $('#agents-status').textContent = 'Could not load agents.';
      $('#agents-status').className = 'status bad';
      return;
    }
    renderCards(decisions.ok ? decisions.items : []);
    // First visit with an empty list: offer discovery once instead of an
    // empty page. Nothing is added until the user confirms.
    if (!registry.agents.length && !offeredDiscovery) {
      offeredDiscovery = true;
      openDiscovery();
    }
  }

  $('#agents-refresh')?.addEventListener('click', load);
  UI.registerView('agents', { onShow: load });
  window.HuqanControlRoomAgents = { renderOverviewPanel, reload: load };
})();
}
