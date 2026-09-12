'use strict';

(() => {
  const view = document.createElement('section');
  view.id = 'v-rules';
  view.className = 'view';
  view.innerHTML = `<div class="head"><div><h1 data-rule-copy="title"></h1><p data-rule-copy="intro"></p></div></div>
    <div class="panel"><div class="pb">
      <p data-rule-copy="scope"></p><p data-rule-copy="limits"></p>
      <details><summary data-rule-copy="setup"></summary><p data-rule-copy="setupHelp"></p>
        <code data-rule-copy="variables"></code></details>
      <div class="field"><label for="policy-token" data-rule-copy="token"></label>
        <input id="policy-token" type="password" autocomplete="off" maxlength="4096" aria-describedby="policy-token-help"></div>
      <p id="policy-token-help" data-rule-copy="tokenHelp"></p>
      <div class="actions"><button class="btn" id="policy-load" type="button" data-rule-copy="load"></button>
        <button class="btn" id="policy-lock" type="button" data-rule-copy="lock"></button></div>
      <div id="policy-status" class="status" role="status" aria-live="polite"></div>
      <fieldset id="policy-fields" disabled style="border:0;padding:0;min-width:0">
        <legend class="sr-only" data-rule-copy="title"></legend>
        <div class="field"><label for="policy-commands" data-rule-copy="commands"></label>
          <textarea id="policy-commands" rows="7" maxlength="51000" spellcheck="false" aria-describedby="policy-prefix"></textarea></div>
        <p id="policy-prefix" data-rule-copy="prefix"></p>
        <label><input id="policy-confirm" type="checkbox"><span data-rule-copy="confirm"></span></label>
        <div class="actions"><button class="btn primary" id="policy-save" type="button" disabled data-rule-copy="save"></button></div>
        <hr><div class="field"><label for="policy-command" data-rule-copy="command"></label>
          <input id="policy-command" maxlength="2000" spellcheck="false"></div>
        <button class="btn" id="policy-preview" type="button" data-rule-copy="preview"></button>
        <p data-rule-copy="previewHelp"></p>
        <pre id="policy-result" class="json" role="status" aria-live="polite"></pre>
      </fieldset>
    </div></div>`;
  document.querySelector('main').append(view);
  const nav = document.createElement('button');
  nav.type = 'button';
  nav.dataset.v = 'rules';
  nav.innerHTML = '<i class="ico" aria-hidden="true">☷</i><span class="copy"><b data-rule-copy="title"></b><span data-rule-copy="nav"></span></span>';
  document.querySelector('.nav button[data-v="settings"]').before(nav);
  nav.onclick = () => window.go('rules');
  const el = id => document.getElementById(`policy-${id}`);
  const labels = {
    title: () => T('commandPolicy.title','Rules'),
    nav: () => T('commandPolicy.nav','Command permissions'),
    intro: () => T('commandPolicy.intro','Manage the shell commands that may pass the command classifier without repeated review.'),
    scope: () => T('commandPolicy.scope','Workspace scope: these commands may skip review only for hooks using this workspace policy. The denylist and classifier still govern every command.'),
    limits: () => T('commandPolicy.limits','This editor manages command permissions only. It does not create file-access prohibitions or verify that an agent hook is installed.'),
    setup: () => T('commandPolicy.setup','Enable policy editing'),
    setupHelp: () => T('commandPolicy.setupHelp','The server operator must configure a separate editor token of at least 32 characters and a policy file in an existing protected directory. Use the same policy path for the server and the hooks. Keep the editor token separate from the agent API key.'),
    token: () => T('commandPolicy.token','Operator token'),
    tokenHelp: () => T('commandPolicy.tokenHelp','Used only for these requests; never saved in browser storage. Lock the editor when finished.'),
    load: () => T('commandPolicy.load','Load saved rules'),
    lock: () => T('commandPolicy.lock','Lock editor'),
    commands: () => T('commandPolicy.commands','Allowed commands — one per line'),
    prefix: () => T('commandPolicy.prefix','An entry also permits extra arguments: npm test matches npm test -- --watch. Broad entries such as node grant broad command permissions. Built-in safety gates still apply.'),
    confirm: () => T('commandPolicy.confirm','I approve this change for every hook using this workspace policy.'),
    save: () => T('commandPolicy.save','Save rules'),
    command: () => T('commandPolicy.command','Command to classify'),
    preview: () => T('commandPolicy.preview','Classify saved rules'),
    previewHelp: () => T('commandPolicy.previewHelp','Nothing is executed. This is the saved policy\'s command classification, not a final allow/block decision or proof of agent enforcement.'),
    waiting: () => T('commandPolicy.waiting','Enter operator credentials and load the saved policy.'),
    working: () => T('commandPolicy.working','Checking…'),
    loaded: () => T('commandPolicy.loaded','Saved rules loaded. Agent enforcement has not been verified.'),
    saved: () => T('commandPolicy.saved','Rules saved. Hooks reading this same file will see the update; agent enforcement has not been verified.'),
    previewed: () => T('commandPolicy.previewed','Saved policy classified the command. Nothing was executed.'),
    unsaved: () => T('commandPolicy.unsaved','Unsaved changes. Save before classifying a command.'),
    notConfigured: () => T('commandPolicy.notConfigured','Policy editing is not configured on this server. Open the setup instructions above.'),
    apiRequired: () => T('commandPolicy.apiRequired','Connect with your API key in Settings first.'),
    operatorRequired: () => T('commandPolicy.operatorRequired','Operator authorization was refused. The agent API key alone cannot edit rules.'),
    conflict: () => T('commandPolicy.conflict','The policy changed elsewhere. Load the latest rules before saving again.'),
    failed: () => T('commandPolicy.failed','The operation failed. No success is confirmed; load the policy again to inspect its state.'),
    category: () => T('commandPolicy.category','Classification'),
    matched: () => T('commandPolicy.matched','Permission entry used'),
    variables: () => T('commandPolicy.variables','Environment variables: HUQAN_POLICY_EDITOR_TOKEN / HUQAN_EXTERNAL_GUARD_POLICY'),
  };
  const copy = key => labels[key]();
  let revision = null;
  let loaded = '';
  let busy = false;
  let message = 'waiting';
  let result = null;
  let generation = 0;
  function render() {
    nav.setAttribute('aria-label', copy('title'));
    document.querySelectorAll('[data-rule-copy]').forEach(node => { node.textContent = copy(node.dataset.ruleCopy); });
    el('status').textContent = copy(message);
    el('result').textContent = result ? `${copy('category')}: ${result.category}\n${copy('matched')}: ${result.matchedCommand || '—'}\n${copy('previewHelp')}` : '';
  }
  function update() {
    el('fields').disabled = busy || !revision;
    el('load').disabled = busy;
    el('save').disabled = busy || !revision || !el('confirm').checked;
    el('preview').disabled = busy || !revision || el('commands').value !== loaded;
  }
  function invalidate() {
    generation++;
    revision = null; loaded = ''; result = null; busy = false; message = 'waiting';
    el('commands').value = ''; el('command').value = ''; el('confirm').checked = false;
    update(); render();
  }
  async function request(method, suffix = '', body) {
    const response = await fetch(`/api/command-policy${suffix}`, {
      method, cache: 'no-store', headers: { 'Content-Type': 'application/json',
        'X-API-Key': state.key, 'X-Huqan-Policy-Token': el('token').value },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error('request_failed'), { status: response.status, code: data.error });
    return data;
  }
  async function perform(action) {
    if (busy) return;
    const current = generation;
    busy = true; message = 'working'; result = null; update(); render();
    try {
      let data;
      if (action === 'load') data = await request('GET');
      if (action === 'save') data = await request('PUT', '', { revision,
        allowedCommands: el('commands').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) });
      if (action === 'preview') data = await request('POST', '/preview', { revision, command: el('command').value });
      if (current !== generation) return;
      if (action === 'preview') { result = data; message = 'previewed'; }
      else {
        revision = data.revision; loaded = data.allowedCommands.join('\n');
        el('commands').value = loaded; el('confirm').checked = false;
        message = action === 'save' ? 'saved' : 'loaded';
      }
    } catch (error) {
      if (current !== generation) return;
      message = error.status === 404 ? 'notConfigured' : error.status === 401 ? 'apiRequired'
        : error.status === 403 ? 'operatorRequired' : error.code === 'POLICY_CHANGED' ? 'conflict' : 'failed';
      revision = null;
    } finally {
      if (current === generation) { busy = false; update(); render(); }
    }
  }
  el('load').onclick = () => perform('load');
  el('save').onclick = () => perform('save');
  el('preview').onclick = () => perform('preview');
  el('lock').onclick = () => { el('token').value = ''; invalidate(); };
  el('token').addEventListener('input', invalidate);
  el('commands').addEventListener('input', () => {
    el('confirm').checked = false; result = null; message = 'unsaved'; update(); render();
  });
  el('command').addEventListener('input', () => { result = null; render(); });
  el('confirm').onchange = update;
  for (const id of ['save', 'clear']) document.getElementById(id).addEventListener('click', () => {
    el('token').value = ''; invalidate();
  });
  window.addEventListener('pagehide', () => { el('token').value = ''; invalidate(); });
  window.addEventListener('huqan-i18n-ready', render);
  window.addEventListener('huqan-locale-change', render);
  update(); render();
})();
