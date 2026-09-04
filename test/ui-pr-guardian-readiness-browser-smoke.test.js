'use strict';

// Browser smoke for the Review Console readiness contract (issue #1826).
//
// `GET /pr-guardian` used to be a static public asset, so the shell loaded
// whatever the deployment was configured to do. An operator with no PR Guardian
// configuration got operator-token, load-reviews and dry-run controls over
// routes that answer 404 by design: the page being there read as the capability
// being there.
//
// The shell now resolves from `prGuardianRouteEnabled`, the same signal its
// reviews API resolves from, so the HTML load *is* the readiness answer. That
// claim is about server.js reading its environment and route-auth-policy
// deciding before any handler runs, so it needs two real deployments rather
// than a mounted handler -- and a real browser, because the point of the issue
// is what a person is shown.
//
// Each deployment runs in its own child process: the operator token is read
// once when the boundary is constructed, so one process can only ever be one
// of the two configurations. Same reason test/memory-approval-http-route.js
// boots a child per case.
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
const API_KEY = 'test-pr-guardian-smoke-key';
const OPERATOR_TOKEN = 'test-pr-guardian-operator-token';
const BOOT_TIMEOUT_MS = 30_000;

const skipReason = browserSmokeSkipReason();

if (skipReason && process.env.HUQAN_REQUIRE_BROWSER_SMOKE === '1') {
  throw new Error(`browser smoke is required but cannot run: ${skipReason}`);
}

/**
 * Boots server.js in a child process and resolves once it prints its port.
 *
 * `configured` decides only whether the operator token is present, so the two
 * deployments differ in exactly the thing the issue is about.
 */
function bootServer({ configured, caseDir }) {
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
    if (${Boolean(configured)}) {
      process.env.HUQAN_MCP_OPERATOR_TOKEN = ${JSON.stringify(OPERATOR_TOKEN)};
    }
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

describe('Review Console readiness browser smoke (#1826)', { skip: skipReason ?? false }, () => {
  let browser;
  let tempDir;
  let unconfigured;
  let configured;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-prg-smoke-'));
    unconfigured = await bootServer({
      configured: false,
      caseDir: fs.mkdtempSync(path.join(tempDir, 'off-')),
    });
    configured = await bootServer({
      configured: true,
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

  it('does not serve the console shell when PR Guardian is unconfigured', async () => {
    const response = await fetch(`${unconfigured.base}/pr-guardian`);
    assert.equal(response.status, 404, 'the shell must be absent, not merely inert');

    // The reviews API is the capability the console drives. Both must give the
    // same answer, or the page is again one step ahead of the backend.
    const api = await fetch(`${unconfigured.base}/api/v2/pr-guardian/reviews`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(api.status, 404, 'reviews API must stay non-disclosing');
  });

  it('renders no operator controls in a browser on an unconfigured deployment', async () => {
    await browser.navigate(`${unconfigured.base}/pr-guardian`);
    const rendered = await browser.evaluate(`JSON.stringify({
      title: document.title,
      hasOperatorToken: Boolean(document.querySelector('[id*="token" i], [placeholder*="token" i]')),
      text: document.body ? document.body.textContent.slice(0, 400) : '',
    })`);
    const page = JSON.parse(rendered);

    assert.doesNotMatch(page.title, /Review Console/i, `console shell was served: ${page.title}`);
    assert.equal(page.hasOperatorToken, false, `operator token control rendered: ${page.text}`);
  });

  it('serves the console shell once PR Guardian is configured', async () => {
    const response = await fetch(`${configured.base}/pr-guardian`);
    assert.equal(response.status, 200);

    await browser.navigate(`${configured.base}/pr-guardian`);
    const title = await browser.evaluate(`document.title`);
    assert.match(title, /Review Console/i, `configured deployment must serve the shell: ${title}`);
  });

  it('keeps the configured console authenticated rather than merely visible', async () => {
    // Serving the shell is a readiness signal, not an authorization one: the
    // reviews route still refuses a caller with no operator token.
    const response = await fetch(`${configured.base}/api/v2/pr-guardian/reviews`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(response.status, 403, 'operator token must still be required');
    const body = await response.json();
    assert.equal(body.error.code, 'OPERATOR_AUTH_REQUIRED');
  });

  it('records no uncaught browser exception or console error across the session', () => {
    assert.deepEqual(browser.exceptions, [], `uncaught browser exceptions: ${browser.exceptions.join(' | ')}`);
    assert.deepEqual(browser.consoleErrors, [], `console errors: ${browser.consoleErrors.join(' | ')}`);
  });
});
