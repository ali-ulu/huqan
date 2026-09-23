'use strict';

(function () {
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ago(iso) {
    if (!iso) return 'unknown time';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'just now';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} h ${mins % 60} min ago`;
    const days = Math.floor(hrs / 24);
    return `${days} d ago`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }

  function closeDrawer() {
    $('#drawer')?.classList.remove('on');
    $('#scrim')?.classList.remove('on');
    $('#drawer')?.setAttribute('aria-hidden', 'true');
  }
  function openDrawer(html) {
    const drawer = $('#drawer');
    if (!drawer) return;
    drawer.innerHTML = html;
    drawer.classList.add('on');
    $('#scrim')?.classList.add('on');
    drawer.setAttribute('aria-hidden', 'false');
    drawer.querySelector('[data-close]')?.focus();
  }

  // ---------- navigation ----------
  const views = {}; // name -> { onShow() }
  function registerView(name, handlers) { views[name] = handlers; }

  function go(view) {
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    $$('.nav button[data-go]').forEach((b) => {
      if (b.dataset.go === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    window.scrollTo({ top: 0 });
    const handler = views[view];
    if (handler && typeof handler.onShow === 'function') handler.onShow();
  }

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
    if (e.target.closest('#d-close') || e.target.id === 'scrim') { closeDrawer(); return; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // ---------- theme ----------
  const THEME_KEY = 'huqan-control-room-theme';
  function applyTheme(value) {
    if (value === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', value);
  }
  (function initTheme() {
    let saved = 'system';
    try { saved = localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { /* private browsing */ }
    applyTheme(saved);
    const select = $('#theme');
    if (select) select.value = saved;
    select?.addEventListener('change', (e) => {
      applyTheme(e.target.value);
      try { localStorage.setItem(THEME_KEY, e.target.value); } catch (_) { /* ignore */ }
    });
  })();

  window.HuqanControlRoomUI = {
    $, $$, esc, ago, toast, openDrawer, closeDrawer, registerView, go,
  };

  // View scripts loaded after this one call registerView() synchronously as
  // they execute; DOMContentLoaded fires only once every script tag in the
  // document (this one included) has run, so every view is registered by
  // the time the first navigation happens.
  document.addEventListener('DOMContentLoaded', () => go('overview'));
})();

/**
 * The Control Room shell around the views: gate status, the API key form
 * (shown only when this server asks for a key), "View as", the Errors view,
 * Customize and saved activity views. Layout and saved views live in this
 * browser only and never hold a key, receipt or workspace secret.
 */
(function () {
  const UI = window.HuqanControlRoomUI;
  const Data = window.HuqanControlRoomData;
  const { $, $$, esc, ago, toast } = UI;

  const store = {
    get(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private browsing: layout lasts this page only */ }
    },
  };

  // ---------- gate status and the key form ----------
  function showKeyForm(reason) {
    const form = $('#session-form');
    if (!form) return;
    form.hidden = false;
    $('#session-note').textContent = reason;
  }

  async function refreshGateStatus() {
    const live = $('#gate-live');
    const health = await Data.fetchHealth();
    if (!health.ok) {
      live.classList.add('down');
      live.lastChild.textContent = 'Gate unreachable';
      return;
    }
    live.classList.remove('down');
    live.lastChild.textContent = `Gate online · ${location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? 'local' : location.hostname}`;
    if (health.apiAuthRequired && !Data.hasKey()) showKeyForm('This HUQAN server asks for an API key.');
  }

  window.addEventListener('huqan:auth-required', () => showKeyForm('HUQAN refused the request. Enter the API key for this server.'));

  $('#session-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    Data.setSession($('#session-key').value.trim(), $('#session-ws').value.trim() || 'default');
    $('#session-key').value = '';
    $('#session-form').hidden = true;
    toast('Key saved to this browser tab.');
    const current = $$('.nav button[aria-current="page"]')[0];
    UI.go(current ? current.dataset.go : 'overview');
  });

  // ---------- view as ----------
  // A preview of what each role sees, as in the design. It hides controls; it
  // does not grant or remove access (roles are not in the runtime yet).
  const ROLE_KEY = 'hq.role';
  function applyRole(role) {
    document.documentElement.dataset.viewAs = role;
    const current = $$('.nav button[aria-current="page"]')[0];
    if (current && current.dataset.roleHide && current.dataset.roleHide.split(' ').includes(role)) UI.go('overview');
  }
  (function initRole() {
    const select = $('#role');
    const saved = store.get(ROLE_KEY, 'admin');
    select.value = saved;
    applyRole(saved);
    select.addEventListener('change', () => { store.set(ROLE_KEY, select.value); applyRole(select.value); });
  })();

  // ---------- errors ----------
  function renderErrors() {
    const errors = Data.systemErrors();
    const badge = $('#nav-errors-count');
    badge.hidden = !errors.length;
    badge.textContent = String(errors.length);
    $('#ov-health-chip').className = `chip ${errors.length ? 'c-err' : 'c-pass'}`;
    $('#ov-health-chip').textContent = errors.length ? `${errors.length} system error${errors.length === 1 ? '' : 's'}` : 'No system errors';
    $('#errors').innerHTML = errors.length ? errors.map((err) => `
      <div class="row"><span class="t"><span class="dot" style="--c:var(--err);margin-right:8px"></span>${esc(err.code)} <span class="mono">${esc(err.path)}</span></span>
      <span class="r" style="color:var(--soft);font-size:12.5px">${esc(ago(err.at))}</span>
      <span class="s">${esc(err.message || (err.status ? `HTTP ${err.status}` : 'No answer from HUQAN'))}</span></div>`).join('')
      : '<p class="empty">No problems with HUQAN itself since this page opened.</p>';
  }
  window.addEventListener('huqan:system-error', renderErrors);

  // Emergency-stop integrity (#2591): the route needs a scoped, single-use
  // operator capability, so every check is one explicit click with a fresh
  // one pasted in. Only a verified answer changes the recorded flag; an
  // unavailable answer (403/404 or network) changes nothing -- unknown is
  // not clean.
  const IBANNER_FLAG = 'huqan-integrity-flag';
  async function checkIntegrityOnce() {
    const input = $('#ib-cap');
    const capability = input.value.trim();
    input.value = ''; // single-use: never retain it
    if (!capability) { toast('Paste a fresh operator capability first.'); return; }
    const result = await Data.fetchEmergencyStopState({ operatorCapability: capability });
    if (!result.ok) {
      toast(`Integrity check unavailable: ${result.error?.message || result.error?.code || 'unknown error'}. Nothing changed.`);
      return;
    }
    const state = result.state || {};
    if (state.integrityViolation === true || state.reason === 'emergency_stop_integrity_violation') {
      const flag = { workspaceId: Data.workspace(), seenAt: new Date().toISOString(), reason: String((state.details && state.details.ledgerReason) || state.reason || '') };
      try { localStorage.setItem(IBANNER_FLAG, JSON.stringify(flag)); } catch (_) { /* banner still shows this session */ }
      window.dispatchEvent(new CustomEvent('huqan:integrity-flag', { detail: flag }));
      toast('Integrity violation confirmed. Agents stay halted.');
      return;
    }
    try { localStorage.removeItem(IBANNER_FLAG); } catch (_) { /* ignore */ }
    window.dispatchEvent(new CustomEvent('huqan:integrity-flag', { detail: null }));
    toast(state.stopped ? 'Stopped, ledger verifies.' : 'Ledger verifies, no violations.');
  }
  $('#ib-check').addEventListener('click', checkIntegrityOnce);

  // ---------- customize ----------
  const WIDGETS = [
    ['verdict', 'Decision summary', 'Watched, passed, waiting, blocked'],
    ['trend', 'Last 7 days', 'Daily actions by decision'],
    ['approvals', 'Waiting on you', 'The top of the approval queue'],
    ['agents', 'Connected agents', 'Who is and isn\'t being watched'],
    ['recent', 'Just now', 'The latest agent actions'],
    ['health', 'System errors notice', 'A one-line pointer to Errors'],
  ];
  const NAV_LABEL = { overview: 'Overview', activity: 'Agent activity', approvals: 'Approvals', receipts: 'Receipts', agents: 'Agents', errors: 'Errors', customize: 'Customize', soon: 'Coming soon' };
  const LOCKED = ['overview', 'customize'];
  const WIDGET_LABEL = Object.fromEntries(WIDGETS.map(([k, t, d]) => [k, [t, d]]));
  const merge = (saved, all) => [...saved.filter((k) => all.includes(k)), ...all.filter((k) => !saved.includes(k))];
  const defaults = () => ({
    nav: { order: Object.keys(NAV_LABEL), hidden: [] },
    widgets: { order: WIDGETS.map((w) => w[0]), hidden: [] },
  });
  const layout = {
    nav: { order: merge(store.get('hq.navOrder', []), Object.keys(NAV_LABEL)), hidden: store.get('hq.navHidden', []).filter((k) => !LOCKED.includes(k)) },
    widgets: { order: merge(store.get('hq.widgetOrder', []), WIDGETS.map((w) => w[0])), hidden: store.get('hq.hidden', []) },
  };

  function saveLayout() {
    store.set('hq.navOrder', layout.nav.order); store.set('hq.navHidden', layout.nav.hidden);
    store.set('hq.widgetOrder', layout.widgets.order); store.set('hq.hidden', layout.widgets.hidden);
  }
  function applyLayout() {
    const nav = $('.nav');
    layout.nav.order.forEach((k) => {
      const b = nav.querySelector(`[data-go="${k}"]`);
      if (!b) return;
      nav.appendChild(b);
      b.classList.toggle('user-hidden', layout.nav.hidden.includes(k));
    });
    layout.widgets.order.forEach((k, i) => {
      const el = $(`[data-widget="${k}"]`);
      if (!el) return;
      el.style.order = i;
      el.classList.toggle('user-hidden', layout.widgets.hidden.includes(k));
    });
  }
  function orderRow(list, k, i, n) {
    const [title, desc] = list === 'nav' ? [NAV_LABEL[k], ''] : WIDGET_LABEL[k];
    const on = !layout[list].hidden.includes(k);
    const locked = list === 'nav' && LOCKED.includes(k);
    const sub = desc ? `<small>${esc(desc)}</small>` : locked ? '<small>Always shown</small>' : '';
    return `<li class="order-item" draggable="true" data-drag-list="${list}" data-key="${k}">
      <span class="grip" aria-hidden="true"><svg viewBox="0 0 10 16" width="10" height="16"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="13" r="1.3"/><circle cx="7" cy="13" r="1.3"/></svg></span>
      <label for="v-${list}-${k}"><input type="checkbox" id="v-${list}-${k}" data-vis="${list}" data-key="${k}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}><span><b>${esc(title)}</b>${sub}</span></label>
      <span class="order-btns"><button class="icon-btn" data-move="-1" data-list="${list}" data-key="${k}" aria-label="Move ${esc(title)} up" ${i === 0 ? 'disabled' : ''}>&uarr;</button><button class="icon-btn" data-move="1" data-list="${list}" data-key="${k}" aria-label="Move ${esc(title)} down" ${i === n - 1 ? 'disabled' : ''}>&darr;</button></span>
    </li>`;
  }
  function renderLayoutLists() {
    ['nav', 'widgets'].forEach((list) => {
      $(`#order-${list}`).innerHTML = layout[list].order.map((k, i, a) => orderRow(list, k, i, a.length)).join('');
    });
  }
  function moveKey(list, key, toIndex) {
    const arr = layout[list].order.filter((k) => k !== key);
    arr.splice(Math.max(0, Math.min(toIndex, arr.length)), 0, key);
    layout[list].order = arr;
    saveLayout(); applyLayout(); renderLayoutLists();
  }

  document.addEventListener('change', (e) => {
    const t = e.target.closest('[data-vis]');
    if (!t) return;
    const { vis: list, key } = t.dataset;
    const h = layout[list].hidden;
    layout[list].hidden = t.checked ? h.filter((x) => x !== key) : [...h, key];
    saveLayout(); applyLayout();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-move]');
    if (!b || b.disabled) return;
    const { list, key, move } = b.dataset;
    moveKey(list, key, layout[list].order.indexOf(key) + Number(move));
    $(`[data-move="${move}"][data-key="${key}"]:not(:disabled)`)?.focus();
  });
  $('#reset-layout').addEventListener('click', () => {
    Object.assign(layout, defaults());
    saveLayout(); applyLayout(); renderLayoutLists();
    toast('Layout reset to default');
  });

  let dragging = null;
  const clearDrop = () => $$('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  const sameList = (it) => dragging && it && it !== dragging && it.dataset.dragList === dragging.dataset.dragList;
  document.addEventListener('dragstart', (e) => {
    const it = e.target.closest?.('[data-drag-list]');
    if (!it) return;
    dragging = it;
    it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', it.dataset.key);
  });
  document.addEventListener('dragover', (e) => {
    const it = e.target.closest?.('[data-drag-list]');
    if (!sameList(it)) return;
    e.preventDefault();
    clearDrop();
    const r = it.getBoundingClientRect();
    it.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
  });
  document.addEventListener('drop', (e) => {
    const it = e.target.closest?.('[data-drag-list]');
    if (!sameList(it)) return;
    e.preventDefault();
    const list = it.dataset.dragList;
    const key = dragging.dataset.key;
    const arr = layout[list].order.filter((k) => k !== key);
    moveKey(list, key, arr.indexOf(it.dataset.key) + (it.classList.contains('drop-after') ? 1 : 0));
    toast(list === 'nav' ? 'Sidebar order saved' : 'Overview order saved');
  });
  document.addEventListener('dragend', () => { dragging?.classList.remove('dragging'); dragging = null; clearDrop(); });

  // ---------- saved activity views ----------
  // Filter values only: search text, agent, tool, decision.
  let saved = store.get('hq.saved', []);
  const FILTERS = { q: '#act-q', agent: '#act-agent', tool: '#act-tool', verdict: '#act-verdict' };
  function setSelect(sel, value) {
    if (value && ![...sel.options].some((o) => o.value === value)) sel.insertAdjacentHTML('beforeend', `<option>${esc(value)}</option>`);
    sel.value = value || '';
  }
  function applyFilter(f) {
    $(FILTERS.q).value = f.q || '';
    setSelect($(FILTERS.agent), f.agent);
    setSelect($(FILTERS.tool), f.tool);
    $(FILTERS.verdict).value = f.verdict || '';
    UI.go('activity');
  }
  function renderSaved() {
    $('#saved').innerHTML = saved.length ? saved.map((s, i) => `<div class="row"><span class="t">${esc(s.name)}</span><span class="r"><button class="btn" data-saved="${i}">Open</button> <button class="btn" data-unsave="${i}" aria-label="Delete ${esc(s.name)}">Delete</button></span>
      <span class="s">${Object.entries(s.f).filter(([, v]) => v).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ') || 'no filters'}</span></div>`).join('')
      : '<p class="empty">No saved views yet. Filter Agent activity and press "Save view".</p>';
  }
  $('#act-save').addEventListener('click', () => {
    const f = Object.fromEntries(Object.entries(FILTERS).map(([k, sel]) => [k, ($(sel).value || '').trim()]));
    const name = Object.values(f).filter(Boolean).join(' · ') || 'All activity';
    saved = [...saved, { name, f }];
    store.set('hq.saved', saved);
    renderSaved();
    toast('View saved to Customize');
  });
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-saved]');
    if (open) { applyFilter(saved[Number(open.dataset.saved)].f); return; }
    const del = e.target.closest('[data-unsave]');
    if (del) { saved = saved.filter((_, i) => i !== Number(del.dataset.unsave)); store.set('hq.saved', saved); renderSaved(); return; }
    const jump = e.target.closest('[data-jump-verdict]');
    if (jump) applyFilter({ verdict: jump.dataset.jumpVerdict });
  });

  // ---------- init ----------
  $$('.nav button[data-go]').forEach((b) => { b.draggable = true; b.dataset.dragList = 'nav'; b.dataset.key = b.dataset.go; b.title = 'Drag to reorder'; });
  applyLayout();
  renderLayoutLists();
  renderSaved();
  renderErrors();
  refreshGateStatus();
})();
