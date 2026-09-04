'use strict';

// Minimal Chrome DevTools Protocol driver for real-browser smoke tests.
//
// The repository ships zero devDependencies on purpose, so this deliberately
// avoids Playwright/Puppeteer. It drives an already-installed Chrome or Edge
// over CDP using the Node global WebSocket, which keeps the browser evidence
// real without adding an install-time dependency or a browser download.
//
// Requires a Node build with global WebSocket (Node >= 22). Callers must use
// `browserSmokeSkipReason()` to skip instead of failing on older runtimes or
// on machines without a Chromium-family browser.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONNECT_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 20_000;
// One unanswered /json/list attempt is not evidence that the browser is stuck;
// the deadline below decides that. This only stops a single attempt from
// waiting forever.
const ATTEMPT_TIMEOUT_MS = 2_000;
// Deliberately more patient than the old attempt counter could ever be: 40
// attempts at 50ms apart bounded a healthy launch at a couple of seconds, and a
// slow CI runner has to stay inside this, or bounding the wait would trade a
// rare hang for a common flake.
const PAGE_TARGET_TIMEOUT_MS = 30_000;

const CHROME_CANDIDATES = Object.freeze([
  process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.platform === 'win32' && 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.platform === 'win32' && 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
].filter(Boolean));

function isExecutableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findBrowser() {
  // An explicit override is authoritative: if HUQAN_CHROME is set and wrong,
  // fall back to nothing rather than silently launching a different browser
  // than the operator asked for.
  const override = process.env.HUQAN_CHROME;
  if (override) return isExecutableFile(override) ? override : null;
  return CHROME_CANDIDATES.find(isExecutableFile) || null;
}

function browserSmokeSkipReason() {
  if (typeof WebSocket !== 'function') return 'global WebSocket is unavailable (needs Node >= 22)';
  if (!findBrowser()) return 'no Chromium-family browser found (set HUQAN_CHROME)';
  return null;
}

function waitForDevToolsEndpoint(child) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`browser did not report a DevTools endpoint in ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    }
    function onData(chunk) {
      buffered += chunk.toString('utf8');
      const match = buffered.match(/ws:\/\/(127\.0\.0\.1|localhost):(\d+)\/devtools\/browser\/\S+/);
      if (!match) return;
      cleanup();
      resolve(Number(match[2]));
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`browser exited early with code ${code}: ${buffered.slice(-400)}`));
    }

    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

/**
 * The browser needs a moment before /json/list reports the initial tab, so this
 * polls -- but the poll has to be bounded in *time*, not in replies.
 *
 * An attempt counter alone bounds only the answers that arrive. A DevTools
 * endpoint that accepts the connection and never answers parks a plain `fetch`
 * forever, and that is what a CI shard saw: the file produced no test output at
 * all and was killed by the 90s per-file cap, while every other await in that
 * hook rejects within 20-30s (#1853). A named failure beats a hang.
 */
async function firstPageTarget(devToolsPort, { deadlineMs = PAGE_TARGET_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`, {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      const targets = await response.json();
      const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (error) {
      // A refused or timed-out attempt is expected while the browser is still
      // coming up; only the deadline decides that it never will.
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`browser never exposed a page target within ${deadlineMs}ms`
    + `${lastError ? ` (last attempt: ${lastError.message})` : ''}`);
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => reject(new Error('CDP socket did not open in time')), CONNECT_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP socket failed to open'));
    }, { once: true });
  });
}

/**
 * Launches a headless browser and returns a small CDP session facade.
 *
 * The session records uncaught exceptions and console errors so a test can
 * assert on them, which is what makes this browser evidence rather than a
 * source-shape assertion.
 */
async function launchBrowserSession() {
  const executable = findBrowser();
  if (!executable) throw new Error('no Chromium-family browser found');

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cdp-'));
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const devToolsPort = await waitForDevToolsEndpoint(child);
  const socket = await connect(await firstPageTarget(devToolsPort));

  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];
  const loadEvents = [];

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails;
      exceptions.push(details?.exception?.description || details?.text || 'unknown exception');
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      consoleErrors.push((message.params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' '));
    } else if (message.method === 'Page.loadEventFired') {
      loadEvents.push(Date.now());
    }
  });

  function send(method, params = {}) {
    const id = (nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Runtime.enable');
  await send('Page.enable');

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async function navigate(url) {
    const seen = loadEvents.length;
    await send('Page.navigate', { url });
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    while (loadEvents.length === seen) {
      if (Date.now() > deadline) throw new Error(`page load timed out: ${url}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  async function close() {
    try { socket.close(); } catch { /* already closing */ }
    child.kill();
    // Do not block teardown forever on a browser that refuses to exit.
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* a leftover profile directory is not a test failure */ }
  }

  return { evaluate, navigate, close, exceptions, consoleErrors, executable };
}

module.exports = { launchBrowserSession, browserSmokeSkipReason, findBrowser, firstPageTarget };
