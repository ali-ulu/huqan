'use strict';

// Capture the research submit before the generic graph workflow dispatcher.
(() => {
  let inFlight = false;
  let result = null;
  let generation = 0;
  let requestWorkspace = '';
  let requestKey = '';
  const sameContext = () => requestWorkspace === state.ws && requestKey === state.key;
  const selected = () => $('action').value === 'web-research';

  function fields() {
    $('researchproviderfield').hidden = !selected();
    $('researchoptionsfield').hidden = !selected();
    if (selected()) {
      $('run').textContent = T('webResearch.search', 'Search the web');
      $('promptlabel').textContent = T('webResearch.prompt', 'Research question');
      $('review').disabled = true;
    }
  }

  function render() {
    if (!result || !selected() || !sameContext()) return;
    const root = $('result');
    root.replaceChildren();
    const note = document.createElement('p');
    note.textContent = `${result.provider} — ${T('webResearch.external', 'External sources; not yet verified. Nothing was saved to memory.')}`;
    root.append(note);
    if (result.summary && result.summary.text) {
      const box = document.createElement('article');
      const head = document.createElement('strong');
      head.textContent = T('webResearch.summaryTitle', 'HUQAN summary (unverified)');
      const body = document.createElement('p');
      body.textContent = result.summary.text;
      box.append(head, body);
      root.append(box);
    } else if (result.summaryStatus === 'unavailable') {
      const warn = document.createElement('p');
      warn.textContent = T('webResearch.summaryUnavailable', 'Summary unavailable; showing sources only.');
      root.append(warn);
    }
    if (!result.sources.length) {
      const empty = document.createElement('p');
      empty.textContent = T('webResearch.empty', 'No results found.');
      root.append(empty);
    }
    for (const source of result.sources) {
      const item = document.createElement('article');
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.title || source.url;
      const snippet = document.createElement('p');
      snippet.textContent = source.snippet;
      const prepare = document.createElement('button');
      prepare.className = 'btn';
      prepare.textContent = T('webResearch.prepare', 'Prepare for learning review');
      prepare.onclick = () => {
        if (!result || !sameContext()) return invalidateResearch();
        $('action').value = 'learn-review';
        $('prompt').value = source.snippet || source.title;
        $('learnsource').value = 'web';
        $('learnref').value = source.url;
        $('learntitle').value = source.title;
        $('action').dispatchEvent(new Event('change'));
        status(T('webResearch.prepared', 'Source prepared. Review before submitting for human approval.'));
      };
      item.append(link, snippet, prepare);
      root.append(item);
    }
  }

  function clearResult() {
    generation += 1;
    result = null;
    if (selected()) $('result').replaceChildren();
    fields();
  }

  function invalidateResearch() {
    generation += 1;
    requestWorkspace = '';
    requestKey = '';
    result = null;
    if (selected()) $('result').replaceChildren();
  }

  $('action').addEventListener('change', clearResult);
  $('researchprovider').addEventListener('change', clearResult);
  $('researchlimit').addEventListener('change', clearResult);
  $('researchsnippet').addEventListener('change', clearResult);
  $('researchsummarize').addEventListener('change', clearResult);
  $('run').addEventListener('click', async event => {
    if (!selected()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (inFlight) return;
    clearResult();
    const current = generation;
    const currentWorkspace = state.ws;
    requestWorkspace = currentWorkspace;
    requestKey = state.key;
    const entry = capability('web-research');
    if (!entry?.availability?.ui) return status(T('webResearch.failed', 'Research unavailable.'), true);
    inFlight = true;
    $('run').disabled = true;
    status(T('webResearch.searching', 'Researching…'));
    try {
      const { r, d } = await json(entry.route, {
        method: entry.method,
        headers: headers(true),
        body: JSON.stringify({ workspaceId: state.ws, provider: $('researchprovider').value, query: $('prompt').value.trim(), limit: Number($('researchlimit').value) || 5, maxSnippet: Number($('researchsnippet').value) || 4000, summarize: $('researchsummarize').checked === true }),
      });
      if (current !== generation || !selected() || !sameContext()) return;
      if (!r.ok || !d.ok) {
        const code = d.error?.code || 'RESEARCH_FAILED';
        const message = code === 'MISSING_API_KEY' ? T('webResearch.missingKey', 'Provider API key missing.') : T('webResearch.failed', 'Research failed.');
        throw Error(`${message} (${code})`);
      }
      result = d.data;
      render();
      status(T('webResearch.external', 'External sources; not yet verified. Nothing was saved to memory.'));
    } catch (error) {
      if (current === generation && selected() && sameContext()) status(error.message, true);
    } finally {
      inFlight = false;
      $('run').disabled = false;
    }
  }, true);
  for (const name of ['huqan-i18n-ready', 'huqan-locale-change']) {
    window.addEventListener(name, () => { fields(); render(); });
  }
  window.addEventListener('huqan-workspace-change', invalidateResearch);
  // The settings form is on the same page, so storage events do not fire in
  // this tab. Clear the old workspace's sources as soon as the operator edits
  // the workspace field, before the next request can be saved.
  $('workspace')?.addEventListener('input', invalidateResearch);
  $('key')?.addEventListener('input', invalidateResearch);
  for (const id of ['save', 'clear']) $(id)?.addEventListener('click', invalidateResearch, true);
  fields();
})();
