'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launchBrowserSession, browserSmokeSkipReason } = require('./helpers/cdp-browser');
const { readAllowedCommands } = require('../lib/external-action-command-policy');

const skip = browserSmokeSkipReason();
if (skip && process.env.HUQAN_REQUIRE_BROWSER_SMOKE === '1') throw new Error(skip);

test('command policy: real dashboard load, save, classify, conflict and locale switch', { skip: skip || false }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-policy-browser-'));
  const policy = path.join(directory, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ allowedCommands: ['npm test'], dataResidency: { allowedDestinations: ['eu'] } }));
  const token = 'test-browser-policy-editor-token-12345';
  const values = { HUQAN_DISABLE_AUTO_LISTEN: '1', HUQAN_API_KEY: 'test-browser-api',
    HUQAN_POLICY_EDITOR_TOKEN: token, HUQAN_EXTERNAL_GUARD_POLICY: policy,
    HUQAN_MEMORY_PATH: path.join(directory, 'memory.json'), HUQAN_DB_PATH: path.join(directory, 'graph.sqlite') };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  function hookDecision(command) {
    const output = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/huqan-gate-hook.js'),
      '--profile', 'generic', '--policy', policy, '--receipt-log', path.join(directory, 'receipts.jsonl'),
      '--memory-path', path.join(directory, 'hook-memory.json'), '--db-path', path.join(directory, 'hook.sqlite')], {
      encoding: 'utf8', input: JSON.stringify({ agentName: 'browser-test', sessionId: 'policy-test',
        toolName: 'shell', args: { command }, cwd: directory, workspaceRoot: directory }),
    });
    assert.ok(output.stdout, output.stderr);
    return JSON.parse(output.stdout).decision;
  }
  assert.notEqual(hookDecision('npm run lint'), 'allow');
  const server = require('../server');
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections(); server.closeHuqan();
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Real central auth must refuse the operator token without transport authentication.
  assert.equal((await fetch(`${base}/api/command-policy`, { headers: { 'X-Huqan-Policy-Token': token } })).status, 401);
  assert.equal((await fetch(`${base}/api/command-policy`, { headers: { 'X-API-Key': values.HUQAN_API_KEY } })).status, 403);
  browser = await launchBrowserSession();
  const evaluate = expression => browser.evaluate(expression);
  async function wait(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Browser condition did not settle: ${expression}; status=${await evaluate("document.getElementById('policy-status')?.textContent")}`);
  }
  await browser.navigate(`${base}/`);
  await evaluate("localStorage.setItem('huqan-locale','tr'); true");
  await browser.navigate(`${base}/`);
  await wait("document.documentElement.lang === 'tr' && document.querySelector('#v-rules h1').textContent === 'Kurallar'");
  await evaluate("document.getElementById('key').value='test-browser-api'; document.getElementById('save').click(); document.querySelector('[data-v=rules]').click(); true");
  await wait("document.getElementById('v-rules').classList.contains('active')");
  assert.equal(await evaluate("document.querySelector('#v-rules h1').textContent"), 'Kurallar');
  assert.equal(await evaluate("document.querySelector('[data-v=rules]').getAttribute('aria-label')"), 'Kurallar');
  await wait("!document.querySelector('.page-scroll-controls').hidden");
  await evaluate("document.querySelector('[data-scroll=down]').click(); true");
  await wait("document.getElementById('v-rules').scrollTop > 20");
  await wait("!document.querySelector('[data-scroll=top]').disabled");
  await evaluate("document.querySelector('[data-scroll=top]').click(); true");
  await wait("document.getElementById('v-rules').scrollTop < 2");
  await evaluate(`document.getElementById('policy-token').value=${JSON.stringify(token)}; document.getElementById('policy-load').click(); true`);
  await wait("!document.getElementById('policy-fields').disabled");
  assert.equal(await evaluate("document.getElementById('policy-commands').value"), 'npm test');
  await evaluate("document.getElementById('policy-commands').value='npm run lint'; document.getElementById('policy-commands').dispatchEvent(new Event('input')); true");
  assert.equal(await evaluate("document.getElementById('policy-save').disabled"), true);
  assert.equal(await evaluate("document.getElementById('policy-preview').disabled"), true);
  await evaluate("document.getElementById('policy-confirm').click(); document.getElementById('policy-save').click(); true");
  await wait("document.getElementById('policy-status').textContent.startsWith('Kurallar kaydedildi')");
  assert.deepEqual(readAllowedCommands(policy), ['npm run lint']);
  assert.equal(hookDecision('npm run lint'), 'allow');
  assert.deepEqual(JSON.parse(fs.readFileSync(policy)).dataResidency, { allowedDestinations: ['eu'] });
  await evaluate("document.getElementById('policy-command').value='npm run lint'; document.getElementById('policy-preview').click(); true");
  await wait("document.getElementById('policy-result').textContent.includes('npm run lint')");
  assert.match(await evaluate("document.getElementById('policy-result').textContent"), /Hiçbir komut çalıştırılmaz/);
  await evaluate("document.getElementById('locale-selector').value='en'; document.getElementById('locale-selector').dispatchEvent(new Event('change')); true");
  await wait("document.querySelector('#v-rules h1').textContent === 'Rules'");
  assert.equal(await evaluate("document.querySelector('#v-rules h1').textContent"), 'Rules');
  assert.match(await evaluate("document.getElementById('policy-result').textContent"), /Nothing is executed/);
  // Another operator edits the file while this tab retains the old revision.
  fs.writeFileSync(policy, JSON.stringify({ allowedCommands: ['node --version'] }));
  await evaluate("document.getElementById('policy-confirm').click(); document.getElementById('policy-save').click(); true");
  await wait("document.getElementById('policy-status').textContent.includes('changed elsewhere')");
  assert.deepEqual(readAllowedCommands(policy), ['node --version']);
  await evaluate("document.getElementById('policy-lock').click(); true");
  assert.equal(await evaluate("document.getElementById('policy-token').value"), '');
  assert.equal(await evaluate("document.getElementById('policy-fields').disabled"), true);
  assert.equal(await evaluate(`Object.values(localStorage).concat(Object.values(sessionStorage)).some(value => value.includes(${JSON.stringify(token)}))`), false);
  assert.deepEqual(browser.exceptions, []);
});
