'use strict';

(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, esc, ago } = UI;

  function render(agents) {
    if (!agents.length) {
      $('#agents-list').innerHTML = '<p class="empty">No agent identity has reached a gate decision in the last 7 days.</p>';
      return;
    }
    const sorted = [...agents.values()].sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    $('#agents-list').innerHTML = sorted.map((a) => `
      <article class="agent">
        <div class="agent-top"><div><h3>${esc(a.id)}</h3><div class="kind">seen via gate decisions</div></div>
        <span class="chip c-pass">Active</span></div>
        <dl><div><dt>Actions</dt><dd class="num">${a.total}</dd></div><div><dt>Blocked</dt><dd class="num">${a.blocked}</dd></div></dl>
        <div class="foot">Last seen ${ago(a.lastSeen)}</div>
      </article>`).join('');
  }

  async function load() {
    $('#agents-status').textContent = 'Loading…';
    $('#agents-status').className = 'status';
    const result = await Data.fetchGateDecisions({ windowMs: 604800000 });
    if (!result.ok) {
      $('#agents-status').textContent = `Could not load agent activity: ${result.error?.message || result.error?.code || 'unknown error'}`;
      $('#agents-status').className = 'status bad';
      return;
    }
    $('#agents-status').textContent = result.truncated ? 'Showing the most recent events in this window; more exist than were read.' : '';
    const agents = new Map();
    result.items.forEach((item) => {
      if (!item.agentId) return;
      const entry = agents.get(item.agentId) || { id: item.agentId, total: 0, blocked: 0, lastSeen: item.createdAt };
      entry.total += 1;
      if (String(item.status).toLowerCase() === 'block') entry.blocked += 1;
      if (new Date(item.createdAt) > new Date(entry.lastSeen)) entry.lastSeen = item.createdAt;
      agents.set(item.agentId, entry);
    });
    render(agents);
  }

  $('#agents-refresh')?.addEventListener('click', load);
  UI.registerView('agents', { onShow: load });
})();
