'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const $ = id => document.getElementById(id);
  const T = (key, fallback, params) => (typeof window !== 'undefined' && window.HUQAN_T ? window.HUQAN_T(key, fallback, params) : fallback);
  const searchInput = byId('search');
  const resultsBox = byId('search-results');
  if (!searchInput || !resultsBox) return;
  const workspace = () => sessionStorage.getItem('huqan-workspace') || 'default';
  let debounceTimer = null;
  let abortCtrl = null;

  const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  function hideResults() {
    resultsBox.hidden = true;
    resultsBox.innerHTML = '';
  }

  function highlight(text, query) {
    if (!query) return escapeHtml(text);
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${esc})`, 'ig');
    return escapeHtml(text).replace(re, '<mark>$1</mark>');
  }

  function navigate(item) {
    const id = item.id;
    const label = item.label;
    // Receipt pattern fallback kept in app-wiring Enter handler
    if (/^(rcpt_|madm_receipt_|receipt)/i.test(id)) {
      byId('einput').value = id;
      if (window.HUQAN_APP_GO) {
        window.HUQAN_APP_GO('evidence');
      } else {
        go('evidence');
      }
      loadReceipt();
      return;
    }
    // Default navigation: go to verify with query
    byId('prompt').value = id;
    go('verify');
  }

  async function doSearch(q) {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    try {
      const url = `/api/global-search?workspaceId=${encodeURIComponent(workspace())}&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { signal: abortCtrl.signal, cache: 'no-store', headers: headers() });
      if (!res.ok) throw new Error('search failed');
      const json = await res.json();
      // A response for a query the box no longer holds must not render.
      if (searchInput.value.trim() !== q) return;
      const items = json.data?.items || [];
      render(items, q);
    } catch (e) {
      if (e.name !== 'AbortError') hideResults();
    }
  }

  function render(items, q) {
    resultsBox.hidden = false;
    if (!items.length) {
      resultsBox.innerHTML = `<div class="search-empty">${escapeHtml(T('search.noResults', 'No results found'))}</div>`;
      return;
    }
    resultsBox.innerHTML = items.slice(0, 10).map(it => {
      const label = highlight(it.label || it.id, q);
      const sub = it.sourceRef ? `${escapeHtml(T('search.source', 'source'))}: ${escapeHtml(it.sourceRef)}` : '';
      return `<div class="search-item" data-id="${escapeHtml(it.id)}" role="option" tabindex="0">
        <div class="search-item-main">${label}</div>
        <div class="search-item-sub">${sub}</div>
      </div>`;
    }).join('');
    // click / keyboard
    resultsBox.querySelectorAll('.search-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const item = items.find(i => i.id === id);
        if (item) navigate(item);
        hideResults();
      });
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { el.click(); }
      });
    });
  }

  searchInput.addEventListener('input', e => {
    const q = e.target.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (abortCtrl) abortCtrl.abort();
    if (q.length < 2) { hideResults(); return; }
    debounceTimer = setTimeout(() => doSearch(q), 300);
  });

  document.addEventListener('click', e => {
    if (!searchInput.contains(e.target) && !resultsBox.contains(e.target)) hideResults();
  });

  // Preserve Enter fallback: let app-wiring handle Enter key
})();
