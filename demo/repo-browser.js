'use strict';

(function () {
  var REPO = 'https://github.com/ali-ulu/huqan';
  var SNAPSHOT = '8e22ab259fe13ee92c2bb3b162c66c733f03f5f9';
  var lang = 'tr';
  var t = window.HUQANI18N;
  var repoEntries = [];
  var repoLoaded = false;
  var repoCategory = '*';
  var repoPage = 0;
  var pageSize = 18;

  function number(value) {
    try { return new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-US').format(value); }
    catch (error) { return String(value); }
  }

  var repoSearch = document.getElementById('repo-search');
  var repoType = document.getElementById('repo-type');
  var repoCategories = document.getElementById('repo-categories');
  var repoResults = document.getElementById('repo-results');
  var repoStatus = document.getElementById('repo-status');
  var repoPageLabel = document.getElementById('repo-page-label');
  var repoPrev = document.getElementById('repo-prev');
  var repoNext = document.getElementById('repo-next');

  function getCategory(entry) {
    var index = entry.path.indexOf('/');
    return index === -1 ? '__root__' : entry.path.slice(0, index);
  }

  function categoryLabel(key) {
    if (key === '__root__') return t[lang].rootLabel;
    return key;
  }

  function renderRepoCategories() {
    if (!repoLoaded) return;
    var counts = {};
    repoEntries.forEach(function (entry) {
      var key = getCategory(entry);
      counts[key] = (counts[key] || 0) + 1;
    });
    var entries = Object.keys(counts).sort(function (a, b) {
      if (a === '__root__') return -1;
      if (b === '__root__') return 1;
      return counts[b] - counts[a] || a.localeCompare(b);
    });
    repoCategories.replaceChildren();
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'repo-category' + (repoCategory === '*' ? ' is-active' : '');
    all.appendChild(document.createTextNode(lang === 'tr' ? 'Tümü' : 'All'));
    var allCount = document.createElement('span');
    allCount.textContent = number(repoEntries.length);
    all.appendChild(allCount);
    all.addEventListener('click', function () { repoCategory = '*'; repoPage = 0; renderRepoCategories(); renderRepoResults(); });
    repoCategories.appendChild(all);

    entries.forEach(function (key) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'repo-category' + (repoCategory === key ? ' is-active' : '');
      button.appendChild(document.createTextNode(categoryLabel(key)));
      var count = document.createElement('span');
      count.textContent = number(counts[key]);
      button.appendChild(count);
      button.addEventListener('click', function () {
        repoCategory = key;
        repoPage = 0;
        renderRepoCategories();
        renderRepoResults();
      });
      repoCategories.appendChild(button);
    });
  }

  function readableSize(size) {
    if (size === null || typeof size === 'undefined') return t[lang].noSize;
    if (size < 1024) return number(size) + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function sourceUrl(entry) {
    var ref = entry.ref || SNAPSHOT;
    var kind = entry.type === 'dir' ? 'tree' : 'blob';
    return REPO + '/' + kind + '/' + ref + '/' + entry.path.split('/').map(encodeURIComponent).join('/');
  }

  function renderRepoResults() {
    if (!repoLoaded) return;
    var query = (repoSearch.value || '').trim().toLowerCase();
    var type = repoType.value || 'all';
    var matches = repoEntries.filter(function (entry) {
      if (repoCategory !== '*' && getCategory(entry) !== repoCategory) return false;
      if (type !== 'all' && entry.type !== type) return false;
      if (query && entry.path.toLowerCase().indexOf(query) === -1) return false;
      return true;
    });
    var totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
    repoPage = Math.max(0, Math.min(repoPage, totalPages - 1));
    var slice = matches.slice(repoPage * pageSize, (repoPage + 1) * pageSize);
    repoStatus.textContent = t[lang].matchCount(matches.length, repoEntries.length);
    repoPageLabel.textContent = t[lang].page(repoPage + 1, totalPages);
    repoPrev.disabled = repoPage <= 0;
    repoNext.disabled = repoPage >= totalPages - 1;
    repoResults.replaceChildren();
    if (!slice.length) {
      var empty = document.createElement('div');
      empty.className = 'repo-empty';
      empty.textContent = t[lang].noMatches;
      repoResults.appendChild(empty);
      return;
    }
    slice.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'repo-result-row';
      var link = document.createElement('a');
      link.className = 'repo-path-link';
      link.href = sourceUrl(entry);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.type === 'dir' ? '▸  ' + entry.path + '/' : '·  ' + entry.path;
      link.title = lang === 'tr' ? 'GitHub kaynağını aç: ' + entry.path : 'Open source on GitHub: ' + entry.path;
      var kind = document.createElement('span');
      kind.className = 'repo-kind' + (entry.type === 'dir' ? ' kind-dir' : '');
      kind.textContent = entry.type === 'dir' ? t[lang].folder : t[lang].file;
      var size = document.createElement('span');
      size.className = 'repo-size';
      size.textContent = entry.type === 'dir' ? '—' : readableSize(entry.size);
      row.appendChild(link);
      row.appendChild(kind);
      row.appendChild(size);
      repoResults.appendChild(row);
    });
  }

  function loadRepoIndex() {
    fetch('./repo-index.json', { cache: 'no-cache', credentials: 'omit' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.entries)) throw new Error('Invalid index');
        repoEntries = data.entries;
        repoLoaded = true;
        var files = repoEntries.filter(function (entry) { return entry.type === 'file'; }).length;
        var dirs = repoEntries.filter(function (entry) { return entry.type === 'dir'; }).length;
        var total = document.getElementById('repo-total');
        var fileEl = document.getElementById('repo-files');
        var dirEl = document.getElementById('repo-dirs');
        var heroCount = document.getElementById('hero-file-count');
        var heroRoots = document.getElementById('hero-root-count');
        if (total) total.textContent = number(repoEntries.length);
        if (fileEl) fileEl.textContent = number(files);
        if (dirEl) dirEl.textContent = number(dirs);
        if (heroCount) heroCount.textContent = number(repoEntries.length);
        if (heroRoots) heroRoots.textContent = number(new Set(repoEntries.map(getCategory).filter(function (key) { return key !== '__root__'; })).size);
        var commitEl = document.getElementById('repo-commit');
        if (commitEl) commitEl.textContent = (data.sourceCommit || SNAPSHOT).slice(0, 12);
        renderRepoCategories();
        renderRepoResults();
      })
      .catch(function () {
        repoStatus.textContent = t[lang].loadError;
        repoResults.replaceChildren();
        var empty = document.createElement('div');
        empty.className = 'repo-empty';
        empty.textContent = t[lang].loadError;
        repoResults.appendChild(empty);
      });
  }

  repoSearch.addEventListener('input', function () { repoPage = 0; renderRepoResults(); });
  repoType.addEventListener('change', function () { repoPage = 0; renderRepoResults(); });
  document.getElementById('repo-clear').addEventListener('click', function () {
    repoSearch.value = '';
    repoType.value = 'all';
    repoCategory = '*';
    repoPage = 0;
    renderRepoCategories();
    renderRepoResults();
    repoSearch.focus();
  });
  repoPrev.addEventListener('click', function () { repoPage -= 1; renderRepoResults(); });
  repoNext.addEventListener('click', function () { repoPage += 1; renderRepoResults(); });

  document.addEventListener('keydown', function (event) {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      var target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      repoSearch.focus();
    }
    if (event.key === 'Escape' && document.activeElement === repoSearch) {
      repoSearch.value = '';
      repoPage = 0;
      renderRepoResults();
    }
  });

  window.addEventListener('huqan:language-change', function (event) {
    lang = event.detail && event.detail.lang === 'en' ? 'en' : 'tr';
    renderRepoCategories();
    renderRepoResults();
  });
  loadRepoIndex();
})();
