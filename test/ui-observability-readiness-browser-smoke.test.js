'use strict';

// Browser smoke for the Observability readiness contract (issue #1825).
//
// The backend fails closed when OBSERVABILITY_AUTHZ_POLICY is absent: it
// answers a typed 503 `OBSERVABILITY_AUTHORIZATION_UNAVAILABLE`, and that is
// correct. The Trust Command Center nevertheless rendered the whole Runs,
// Events, Queue and Alert UI with its controls live, and only reported the
// failure once the requests came back — so an unconfigured deployment was
// presented as an active dashboard that happened to show `—` everywhere.
//
// This drives the real page in a real browser against two real deployments,
// which differ only in whether the authorization policy is configured. The
// policy is read when the server builds its observability runtime, so each
// deployment needs its own process.
//
// Skips instead of failing when the runtime has no global WebSocket or the
// machine has no Chromium-family browser. See test/helpers/cdp-browser.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchBrowserSession, browserSmokeSkipReason } = require('./helpers/cdp-browser');

const repoRoot = path.resolve(__dirname, '..');
const API_KEY = 'test-observability-smoke-key';
const WAIT_TIMEOUT_MS = 20_000;
const BOOT_TIMEOUT_MS = 30_000;

const skipReason = browserSmokeSkipReason();

if (skipReason && process.env.HUQAN_REQUIRE_BROWSER_SMOKE === '1') {
  throw new Error(`browser smoke is required but cannot run: ${skipReason}`);
}

function bootServer({ policy, caseDir }) {
  const script = `
    const path = require('path');
    const caseDir = process.argv[1];
    Object.assign(process.env, {
      HUQAN_DISABLE_AUTO_LISTEN: '1',
      HUQAN_API_KEY: ${JSON.stringify(API_KEY)},
      HUQAN_MEMORY_PATH: path.join(caseDir, 'memory.json'),
      HUQAN_DB_PATH: path.join(caseDir, 'graph.sqlite'),
      HUQAN_BACKUP_DIR: path.join(caseDir, 'backups'),
      HUQAN_KERNEL_VERSION: 'v2',
    });
    const policy = ${JSON.stringify(policy || '')};
    if (policy) process.env.HUQAN_OBSERVABILITY_AUTHZ_POLICY = policy;
    const server = require(path.join(${JSON.stringify(repoRoot)}, 'server.js'));
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT=' + server.address().port + '\\n');
    });
  `;

  const child = spawn(process.execPath, ['-e', script, caseDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not boot in ${BOOT_TIMEOUT_MS}ms; stderr: ${err}`));
    }, BOOT_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      out += chunk;
      const match = out.match(/PORT=(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, base: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}; stderr: ${err}`));
    });
  });
}

async function stopServer(handle) {
  if (!handle?.child) return;
  handle.child.kill();
  await new Promise(resolve => {
    handle.child.once('exit', resolve);
    setTimeout(resolve, 5_000);
  });
}

describe('Observability readiness browser smoke (#1825)', { skip: skipReason ?? false }, () => {
  let browser;
  let tempDir;
  let unconfigured;
  let configured;

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

  // Open the Observability view the way a user does, which is what triggers
  // the load and therefore the readiness decision.
  async function openObservability(base) {
    await browser.navigate(`${base}/`);
    await browser.evaluate(`
      document.getElementById('key').value = ${JSON.stringify(API_KEY)};
      document.getElementById('workspace').value = 'default';
      document.getElementById('save').click();
      document.querySelector('[data-v="observability"]').click();
      true;
    `);
  }

  function writeControlsDisabled() {
    return `[...document.querySelectorAll('#obsqueueform button[type=submit], #obsalertform button[type=submit], #obsgoal, #obsalertname')]
      .every(el => el.disabled)`;
  }

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-obs-smoke-'));
    unconfigured = await bootServer({
      policy: '',
      caseDir: fs.mkdtempSync(path.join(tempDir, 'off-')),
    });
    configured = await bootServer({
      policy: JSON.stringify({ memberships: [{ subject: 'local-api-key', workspaceId: 'default', role: 'admin' }] }),
      caseDir: fs.mkdtempSync(path.join(tempDir, 'on-')),
    });
    browser = await launchBrowserSession();
  });

  after(async () => {
    try {
      await browser?.close();
    } catch {
      // Teardown trouble is not a product failure; the assertions already ran.
    }
    await stopServer(unconfigured);
    await stopServer(configured);
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best effort */ }
  });

  it('backend stays fail-closed when the authorization policy is absent', async () => {
    const response = await fetch(`${unconfigured.base}/api/observability/metrics?workspaceId=default`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(response.status, 503, 'the typed fail-closed answer must be unchanged');
    const body = await response.json();
    assert.equal(body.error.code, 'OBSERVABILITY_AUTHORIZATION_UNAVAILABLE');
  });

  it('presents an explicit NOT CONFIGURED state instead of an active dashboard', async () => {
    await openObservability(unconfigured.base);
    const banner = await waitFor(
      `(() => {
        const el = document.getElementById('obsreadiness');
        return el && !el.hidden && /NOT CONFIGURED/.test(el.textContent) ? el.textContent : false;
      })()`,
      'the NOT CONFIGURED readiness banner',
    );

    // The operator needs to be told what to do, not merely that it failed.
    assert.match(banner, /OBSERVABILITY_AUTHZ_POLICY/, `banner names no operator action: ${banner}`);
    assert.equal(
      await browser.evaluate(writeControlsDisabled()),
      true,
      'queue and alert controls must not be presented as usable',
    );
  });

  it('discloses no policy contents in the unconfigured state', async () => {
    // The readiness signal says the deployment is unconfigured. It must not
    // become a channel for the configuration itself.
    const text = await browser.evaluate(`document.getElementById('v-observability').textContent`);
    assert.doesNotMatch(text, /memberships/i, 'policy contents leaked into the page');
    assert.doesNotMatch(text, new RegExp(API_KEY), 'session key leaked into the page');
  });

  it('enables the operational controls once authorization is configured', async () => {
    await openObservability(configured.base);
    await waitFor(
      `(() => {
        const el = document.getElementById('obsreadiness');
        return Boolean(el && el.hidden);
      })()`,
      'the readiness banner to clear on a configured deployment',
    );
    assert.equal(
      await browser.evaluate(writeControlsDisabled()),
      false,
      'a configured deployment must keep its controls usable',
    );
  });

  it('records no uncaught browser exception across the session', () => {
    assert.deepEqual(browser.exceptions, [], `uncaught browser exceptions: ${browser.exceptions.join(' | ')}`);
  });
});
