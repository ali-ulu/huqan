'use strict';

// Real Chromium UI evidence with explicit provider-response fixtures. This
// does not claim live provider credentials or outbound API availability.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchBrowserSession, browserSmokeSkipReason } = require('./helpers/cdp-browser');
const skip = browserSmokeSkipReason();
if (skip && process.env.HUQAN_REQUIRE_BROWSER_SMOKE === '1') throw Error(skip);

describe('Web research real-browser UI with provider fixtures', { skip: skip || false }, () => {
  let server, browser, tempDir;
  const previous = {};
  async function waitFor(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await browser.evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Browser condition timed out: ${expression}`);
  }
  async function search(provider = 'brave') {
    await browser.evaluate(`(() => {
      document.getElementById('action').value = 'web-research';
      document.getElementById('action').dispatchEvent(new Event('change'));
      document.getElementById('researchprovider').value = ${JSON.stringify(provider)};
      document.getElementById('researchprovider').dispatchEvent(new Event('change'));
      document.getElementById('prompt').value = 'fixture research question';
      document.getElementById('run').click();
    })()`);
    await waitFor("document.querySelector('#result article button') && !document.getElementById('run').disabled");
  }
  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-research-browser-'));
    const env = {
      AXIOM_MEMORY_PATH: path.join(tempDir, 'memory.json'), AXIOM_DB_PATH: path.join(tempDir, 'memory.db'),
      AXIOM_BACKUP_DIR: path.join(tempDir, 'backups'), AXIOM_KERNEL_VERSION: 'v2',
      AXIOM_DISABLE_AUTO_LISTEN: '1', AXIOM_API_KEY: 'research-browser-test-key',
    };
    for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; }
    server = require('../server');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); server.startServer(0); });
    browser = await launchBrowserSession();
    await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
    await browser.evaluate(`(() => {
      document.getElementById('key').value = 'research-browser-test-key';
      document.getElementById('workspace').value = 'default';
      document.getElementById('save').click();
    })()`);
    await waitFor("document.getElementById('wstate').textContent === 'READY'");
    await browser.evaluate(`(() => {
      const realFetch = window.fetch.bind(window);
      window.researchFixtureCalls = [];
      window.fetch = async (url, init) => {
        if (String(url).includes('/api/v2/workflows/')) window.researchFixtureCalls.push({ url: String(url), body: JSON.parse(init.body) });
        if (!String(url).includes('/api/v2/workflows/research')) return realFetch(url, init);
        const input = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, data: { provider: input.provider, sources: [{
          title: '<img src=x onerror=alert(1)> fixture', url: 'https://example.com/research', snippet: '<script>fixture</script> safe text'
        }], canonicalWrite: false, evidenceStatus: 'external_unverified' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
    })()`);
  });
  after(async () => {
    await browser?.close();
    server?.closeAllConnections?.(); server?.closeIdleConnections?.(); server?.closeHuqan?.();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it('selects each provider and renders fixture sources as safe text', async () => {
    assert.deepEqual(await browser.evaluate("[...document.getElementById('researchprovider').options].map(o => o.value)"), ['brave', 'firecrawl', 'tavily']);
    for (const provider of ['brave', 'firecrawl', 'tavily']) {
      await search(provider);
      const result = await browser.evaluate(`(() => ({ last: window.researchFixtureCalls.at(-1),
        title: document.querySelector('#result article a').textContent,
        href: document.querySelector('#result article a').href,
        unsafeElements: document.querySelectorAll('#result img, #result script').length }))()`);
      assert.equal(result.last.body.provider, provider);
      assert.equal(result.last.body.workspaceId, 'default');
      assert.equal(result.title, '<img src=x onerror=alert(1)> fixture');
      assert.equal(result.href, 'https://example.com/research');
      assert.equal(result.unsafeElements, 0);
    }
  });
  it('prepares learning review without submitting a write', async () => {
    await search();
    const beforeCount = await browser.evaluate('window.researchFixtureCalls.length');
    const form = await browser.evaluate(`(() => {
      document.querySelector('#result article button').click();
      return { action: document.getElementById('action').value, source: document.getElementById('learnsource').value,
        reference: document.getElementById('learnref').value, prompt: document.getElementById('prompt').value };
    })()`);
    assert.deepEqual(form, { action: 'learn-review', source: 'web', reference: 'https://example.com/research', prompt: '<script>fixture</script> safe text' });
    assert.equal(await browser.evaluate('window.researchFixtureCalls.length'), beforeCount);
  });
  it('shows persisted browser destination and reported outcome in the real activity pane', async () => {
    const { normalizeHookInvocation } = require('../lib/external-action-adapter');
    const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');
    const { buildExternalActionAdmissionReceipt, createDurableExternalActionReceiptWriter } = require('../lib/external-action-receipt');
    const { recordBrowserHookOutcome } = require('../lib/browser-hook-outcome');
    const payload = { hook_event_name: 'PostToolUse', tool_use_id: 'ui-browser-1', session_id: 'ui-session',
      tool_name: 'mcp__browser__navigate', tool_input: { url: 'https://example.com/observed?private=secret' }, cwd: tempDir };
    const envelope = normalizeExternalActionEnvelope(normalizeHookInvocation('claude-code', payload));
    const writer = createDurableExternalActionReceiptWriter({ path: path.join(tempDir, 'browser.jsonl'),
      memoryPath: path.join(tempDir, 'memory.json'), dbPath: path.join(tempDir, 'memory.db') });
    let outcome;
    try {
      writer.append(buildExternalActionAdmissionReceipt(envelope, { decision: 'allow', reason: 'fixture', findings: [] }));
      outcome = recordBrowserHookOutcome('claude-code', payload, { receiptWriter: writer });
    } finally { writer.close(); }
    await browser.evaluate(`go('activity'); $('activityevent').value='EXTERNAL_ACTION_OUTCOME_RECEIPT'; loadActivity(true); true;`);
    await waitFor(`state.activity.items.some(x=>x.receipt?.receiptId===${JSON.stringify(outcome.receiptId)})`);
    const detail = await browser.evaluate(`(() => { showActivity(state.activity.items.find(x=>x.receipt?.receiptId===${JSON.stringify(outcome.receiptId)}).auditId); return $('activitysummary').textContent; })()`);
    assert.ok(detail.includes('https://example.com/observed'));
    assert.ok(detail.includes('mcp__browser__navigate'));
    assert.ok(detail.includes('executed'));
    assert.ok(!detail.includes('private=secret'));
  });
  it('invalidates results immediately on workspace and key edits', async () => {
    for (const id of ['workspace', 'key']) {
      await search();
      const count = await browser.evaluate(`(() => {
        const field = document.getElementById(${JSON.stringify(id)});
        field.value += '-changed'; field.dispatchEvent(new Event('input'));
        return document.querySelectorAll('#result article').length;
      })()`);
      assert.equal(count, 0, id);
    }
    assert.deepEqual(browser.exceptions, []);
  });
});
