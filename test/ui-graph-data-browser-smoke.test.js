'use strict';

// Browser smoke for the default-workspace graph contract (issue #1821).
//
// The backend publishes `GET /graph-data` without authentication for the
// default workspace only (lib/http/route-auth-policy.js), but the Command
// Center used to short-circuit `loadGraph()` whenever no API key was stored,
// so the bundled default graph view could never render for a first-time
// visitor. This smoke drives the real page in a real browser against a real
// server and covers the three states the issue names:
//
//   1. empty session + default workspace  -> graph loads, never LOCKED
//   2. empty session + named workspace    -> graph stays LOCKED (no request)
//   3. authenticated named workspace      -> graph loads
//
// Skips instead of failing when the runtime has no global WebSocket or the
// machine has no Chromium-family browser. See test/helpers/cdp-browser.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchBrowserSession, browserSmokeSkipReason } = require('./helpers/cdp-browser');

const TEST_API_KEY = 'test-ui-graph-smoke-secret';
const NAMED_WORKSPACE = 'team-a';
const WAIT_TIMEOUT_MS = 15_000;

const skipReason = browserSmokeSkipReason();

if (skipReason && process.env.HUQAN_REQUIRE_BROWSER_SMOKE === '1') {
  throw new Error(`browser smoke is required but cannot run: ${skipReason}`);
}

describe('default-workspace graph browser smoke (#1821)', { skip: skipReason ?? false }, () => {
  let server;
  let browser;
  let tempDir;
  let base;

  async function waitFor(expression, description) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let last;
    while (Date.now() < deadline) {
      last = await browser.evaluate(expression);
      if (last) return last;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${description} (last value: ${JSON.stringify(last)})`);
  }

  // The page renders the surface label into #meshbadgestate as `● LIVE`,
  // `● LOCKED`, `● EMPTY`, `● ERROR` or `● CHECKING`, so the assertion reads
  // what a user would see rather than reaching into the page's closure.
  function graphBadge() {
    return `document.getElementById('meshbadgestate').textContent`;
  }

  async function saveSettings(key, workspace) {
    await browser.evaluate(`
      document.getElementById('key').value = ${JSON.stringify(key)};
      document.getElementById('workspace').value = ${JSON.stringify(workspace)};
      document.getElementById('save').click();
      true;
    `);
    // Wait for the save cycle itself, not for a badge value.
    //
    // save() disables the button, awaits refresh(), and re-enables it in a
    // finally, so the button is the one signal that means *this* save finished.
    // "The badge is not CHECKING" accepted the badge left over from the
    // previous case, because the surface had not gone back to CHECKING yet --
    // the assertion then read a stale verdict and the smoke failed
    // intermittently on a race in the test rather than in the product.
    await waitFor(
      `!document.getElementById('save').disabled`
      + ` && !/● CHECKING/.test(document.getElementById('meshbadgestate').textContent)`,
      'the save cycle to complete and the graph surface to settle',
    );
  }

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-smoke-'));
    process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
    process.env.AXIOM_DB_PATH = path.join(tempDir, 'memory.db');
    process.env.AXIOM_BACKUP_DIR = path.join(tempDir, 'backups');
    process.env.AXIOM_KERNEL_VERSION = 'v2';
    process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
    process.env.AXIOM_API_KEY = TEST_API_KEY;

    server = require('../server');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.startServer(0);
    });
    base = `http://127.0.0.1:${server.address().port}`;

    browser = await launchBrowserSession();
    await browser.navigate(`${base}/`);
  });

  after(async () => {
    try {
      await browser?.close();
    } catch {
      // A browser that will not shut down cleanly is a teardown problem, not a
      // product failure; the assertions above already ran.
    }
    server?.closeAllConnections?.();
    server?.closeIdleConnections?.();
    server?.closeHuqan?.();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    delete process.env.AXIOM_MEMORY_PATH;
    delete process.env.AXIOM_DB_PATH;
    delete process.env.AXIOM_BACKUP_DIR;
    delete process.env.AXIOM_KERNEL_VERSION;
    delete process.env.AXIOM_DISABLE_AUTO_LISTEN;
    delete process.env.AXIOM_API_KEY;
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best effort */ }
  });

  it('loads the graph for the default workspace without an API key', async () => {
    // Fresh navigation means empty sessionStorage: no key, workspace 'default'.
    // The frontend must attempt /graph-data, which the backend serves publicly
    // for the default workspace, and the surface must never read LOCKED.
    await waitFor(
      `/● (LIVE|EMPTY|LOCKED|ERROR)/.test(${graphBadge()})`,
      'the graph surface to leave CHECKING',
    );
    const badge = await browser.evaluate(graphBadge());
    assert.doesNotMatch(badge, /LOCKED/, `default graph locked without a key: ${badge}`);
    assert.doesNotMatch(badge, /ERROR/, `default graph errored without a key: ${badge}`);
  });

  it('keeps a named workspace locked when the session has no API key', async () => {
    await saveSettings('', NAMED_WORKSPACE);
    const badge = await browser.evaluate(graphBadge());
    assert.match(badge, /LOCKED/, `named workspace without a key must stay locked: ${badge}`);
  });

  it('loads the graph for a named workspace once the session is authenticated', async () => {
    await saveSettings(TEST_API_KEY, NAMED_WORKSPACE);
    const badge = await browser.evaluate(graphBadge());
    assert.doesNotMatch(badge, /LOCKED/, `authenticated named workspace still locked: ${badge}`);
    assert.doesNotMatch(badge, /ERROR/, `authenticated named workspace errored: ${badge}`);
  });

  it('records no uncaught browser exception or console error across the session', () => {
    assert.deepEqual(browser.exceptions, [], `uncaught browser exceptions: ${browser.exceptions.join(' | ')}`);
    assert.deepEqual(browser.consoleErrors, [], `console errors: ${browser.consoleErrors.join(' | ')}`);
  });
});