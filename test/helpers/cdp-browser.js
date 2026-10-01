'use strict';

// Minimal Chrome DevTools Protocol driver for real-browser smoke tests.
//
// The repository keeps its browser evidence on a raw CDP connection rather
// than a Playwright/Puppeteer driver, so the smoke adds no browser download and
// no runtime dependency. It drives an already-installed Chrome or Edge
// over CDP using the Node global WebSocket, which keeps the browser evidence
// real without adding an install-time dependency or a browser download.
//
// Requires a Node build with global WebSocket (Node >= 22). Callers must use
// `browserSmokeSkipReason()` to skip instead of failing on older runtimes or
// on machines without a Chromium-family browser.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONNECT_TIMEOUT_MS = 20_000;
// A launch has to fit inside the shard runner's per-file deadline, so the
// endpoint wait is generous enough for a loaded runner but still bounded. It
// used to share the 20s socket-connect value, and a shard on a loaded runner hit
// it while the browser was still starting (#3240).
const DEVTOOLS_ENDPOINT_TIMEOUT_MS = 30_000;
// How often the launch polls for the DevToolsActivePort file and the stderr
// banner. Small enough to add no visible latency, large enough to stay cheap.
const ACTIVE_PORT_POLL_MS = 50;
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

// Killing a browser means killing everything it started, not just the process
// this helper spawned. `child.kill()` signals the parent alone; Chrome forks a
// zygote plus a renderer/gpu/utility child per site and leaves a `cat` reading
// the stderr pipe, and those descendants are what kept a smoke test's process
// alive after `close()` returned (#3161, the residue of #2814). `close()` reads
// this process table to collect them instead.
//
// The probe runs once, at teardown, and only ever kills pids that descend from
// the browser this helper launched -- never a broad name-based match.
const PROCESS_PROBE_TIMEOUT_MS = 5_000;
// How long the killed tree gets to die on its own before SIGKILL. Deliberately
// a constant rather than a knob: it is a race-window inside an already bounded
// teardown, and tuning it per call would make a hang look like a configuration
// choice.
const KILL_GRACE_MS = 3_000;
// Absolute bound on close(), so a browser that ignores both signals cannot
// outlive the file that started it. Kept well under the smoke's own timeouts
// (WAIT/COMMAND are 15-20s) so teardown stays a small part of the file budget.
const CLOSE_DEADLINE_MS = 15_000;
// A loaded CI runner can miss the endpoint deadline while the same binary
// starts in seconds locally (#3240's residue). One retry absorbs that transient
// miss without masking a page failure, which the launch legs cannot produce.
const LAUNCH_ATTEMPTS = 2;

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
  // An explicit opt-out for a CI runner where browser smokes are not a trusted
  // signal (#2450: the windows-latest runner renders empty panels that pass on a
  // local Windows machine). Its value is the reason, so the skip says why.
  const optOut = String(process.env.HUQAN_SKIP_BROWSER_SMOKE || '').trim();
  if (optOut && optOut !== '0') return `browser smoke skipped by HUQAN_SKIP_BROWSER_SMOKE: ${optOut}`;
  if (typeof WebSocket !== 'function') return 'global WebSocket is unavailable (needs Node >= 22)';
  if (!findBrowser()) return 'no Chromium-family browser found (set HUQAN_CHROME)';
  return null;
}

/**
 * Parse a `pid ppid ...` process table into rows (POSIX `ps`) or `pid|ppid|cmd`
 * (Windows PowerShell). Same two shapes `scripts/shard-hang-diagnostics.js`
 * reads, kept separate because that module is a CI entrypoint and this one is a
 * test helper a smoke can require.
 */
function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (line.includes('|')) {
      const [pid, ppid, ...rest] = line.split('|');
      rows.push({ pid: Number(pid), ppid: Number(ppid), command: rest.join('|').trim() });
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() });
  }
  return rows.filter(row => Number.isInteger(row.pid) && Number.isInteger(row.ppid));
}

/** The live process table, or an empty list on a platform that cannot produce one. */
function readProcessTable() {
  const [command, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }']]
    : ['ps', ['-e', '-o', 'pid=,ppid=,args=']];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: PROCESS_PROBE_TIMEOUT_MS, windowsHide: true });
  if (result.error || typeof result.stdout !== 'string') return [];
  return parseProcessTable(result.stdout);
}

/**
 * Every descendant of `rootPid`, parents before children.
 *
 * Scoped to this helper's own launched browser: only pids reachable from
 * `rootPid` are returned, so a signal can never reach an unrelated process.
 */
function collectDescendants(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const collected = [];
  const walk = pid => {
    for (const row of byParent.get(pid) || []) {
      collected.push(row.pid);
      walk(row.pid);
    }
  };
  walk(rootPid);
  return collected;
}

/** One pid, never a name. Ignores a pid that already exited. */
function terminatePid(pid, signal) {
  try { process.kill(pid, signal); } catch { /* already gone, or not ours to kill */ }
}

/**
 * Fell the tree under `rootPid` without a process table (Windows only).
 *
 * The CIM probe times out on a loaded leg and reports no rows for a tree that
 * is demonstrably alive; `taskkill /T` kills by parentage instead of by list,
 * so it needs no table. Best-effort: failure leaves the per-pid signals as
 * the backstop, never a thrown error. Kept beside (not inside)
 * scripts/shard-hang-diagnostics.js for the same reason the table parser is
 * duplicated there: that module is a CI entrypoint, this one is a test helper
 * a smoke can require.
 */
function taskkillTree(rootPid) {
  if (process.platform !== 'win32') return false;
  try {
    const result = spawnSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: PROCESS_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Terminate the browser this helper launched and every descendant it left
 * behind, then wait (bounded) for the tree to actually be gone.
 *
 * Returns `{ descendants, stragglers }`: the descendants that were signalled,
 * and the pids still alive after SIGKILL for the log line. `child.kill()` alone
 * leaves the descendants running (#3161), and those descendants are what kept
 * the smoke's process alive.
 */
async function killProcessTree(child) {
  // One retry for a blind probe: the CIM query times out on a loaded leg and
  // reports no rows for a demonstrably alive tree, and a second read a beat
  // later usually sees it. Only a twice-blind probe kills by parentage, which
  // needs no table; `descendants` then stays empty so the caller still sees
  // the probe contributed nothing.
  let rows = readProcessTable();
  if (rows.length === 0) {
    await new Promise(resolve => setTimeout(resolve, 500));
    rows = readProcessTable();
  }
  const descendants = collectDescendants(rows, child.pid);
  if (rows.length === 0) taskkillTree(child.pid);
  const signalAll = signal => {
    // Children before their parents, so a killed parent cannot orphan and hide
    // the descendants still to be signalled in a re-read of the table.
    for (const pid of [...descendants].reverse()) terminatePid(pid, signal);
    terminatePid(child.pid, signal);
  };
  signalAll('SIGTERM');
  await waitForExit(child, KILL_GRACE_MS);
  signalAll('SIGKILL');
  // Reap the parent so its exit event fires even when the tree was already gone.
  try { child.kill('SIGKILL'); } catch { /* already dead */ }
  await waitForExit(child, KILL_GRACE_MS);
  return { descendants, stragglers: [child.pid, ...descendants].filter(isAlive), probedRows: rows.length };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function isAlive(pid) {
  // A killed process whose parent has not reaped it is left as a zombie; a
  // zombie still answers signal 0, which would report a dead process as a
  // straggler and put a false "did not reap" line in the smoke log. Read the
  // kernel state where it is exposed, exactly as the diagnostics test does.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    // No /proc entry (macOS, Windows, or a pid that is truly gone): the signal
    // probe answers correctly whenever the pid is not a zombie.
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}

/**
 * The DevTools port Chrome chose for `--remote-debugging-port=0`.
 *
 * Chrome writes `<user-data-dir>/DevToolsActivePort` (port on the first line)
 * as soon as its DevTools server is up. Reading it is the canonical discovery
 * -- it does not depend on the stderr wording or on which address family the
 * server bound to, so a launch that is slow to print, or prints an address the
 * stderr regex does not match, is still found (#3240).
 */
function readActivePort(profileDir) {
  if (!profileDir) return null;
  try {
    const [firstLine] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n');
    const port = Number(firstLine.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function waitForDevToolsEndpoint(child, { timeoutMs = DEVTOOLS_ENDPOINT_TIMEOUT_MS, profileDir } = {}) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let settled = false;

    // Both signals are polled, because either can arrive first: the file is the
    // canonical one, the stderr line stays as a fallback for a browser that
    // does not write it. The poll is bounded by `timeoutMs`, not by an attempt
    // count, so an endpoint that never answers cannot park this forever.
    const poll = setInterval(() => {
      const port = readActivePort(profileDir);
      if (port !== null) return finish(null, port);
      const match = buffered.match(/ws:\/\/(127\.0\.0\.1|localhost):(\d+)\/devtools\/browser\/\S+/);
      if (match) finish(null, Number(match[2]));
    }, ACTIVE_PORT_POLL_MS);

    const timer = setTimeout(() => {
      finish(new Error(`browser did not report a DevTools endpoint in ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    }
    function finish(error, port) {
      if (settled) return;
      cleanup();
      if (error) reject(error);
      else resolve(port);
    }
    function onData(chunk) {
      buffered += chunk.toString('utf8');
    }
    function onExit(code) {
      finish(new Error(`browser exited early with code ${code}: ${buffered.slice(-400)}`));
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
    let socket;
    try {
      socket = new WebSocket(webSocketDebuggerUrl);
    } catch (error) {
      // A malformed url throws synchronously; without this the timer below is
      // never created and the promise never settles (#3161).
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* already closing */ }
      reject(new Error('CDP socket did not open in time'));
    }, CONNECT_TIMEOUT_MS);
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
 * Spawn the browser and bring its DevTools session up. Split out of
 * launchBrowserSession so a transient launch failure can be retried without
 * rebuilding the CDP facade. A failure reaps the child it spawned and removes
 * its profile directory before rethrowing.
 *
 * @returns {Promise<{child: import('node:child_process').ChildProcess, socket: WebSocket, profileDir: string}>}
 */
async function openBrowserSession(executable, devToolsTimeoutMs) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cdp-'));
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    // Browser-smoke assertions use the repository's English contract copy.
    // Pin the test browser so host locale cannot silently change the DOM.
    '--lang=en-US',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // The browser's stderr pipe is drained by waitForDevToolsEndpoint and the
  // child's exit removes the reader. Closing it eagerly in close() can raise
  // EPIPE on the pipe; without a listener that surfaces as an uncaught 'error'
  // and becomes the very hang this helper is fixing (#3161). The pipe carries
  // launch diagnostics only, so a late write fault has no signal to preserve.
  child.stderr.on('error', () => {});

  // Both launch awaits have to be inside the try: waitForDevToolsEndpoint
  // rejects on its own 30s deadline when the browser never announces a DevTools
  // endpoint, and that is exactly the launch the cleanup below exists for.
  // Leaving it outside the try left the child and its tree alive, so the file
  // was killed by the 240s heavy-file deadline with no test output at all
  // (#3240 -- the remaining leg of #3161).
  let socket;
  try {
    const devToolsPort = await waitForDevToolsEndpoint(child, { timeoutMs: devToolsTimeoutMs, profileDir });
    socket = await connect(await firstPageTarget(devToolsPort));
  } catch (error) {
    // A launch that fails (no DevTools endpoint, no page target, a refused
    // socket) must not leak the browser it already spawned. The caller's
    // `browser` binding is still undefined at this point, so its `after()` hook
    // cannot close it -- without this the child and its tree outlive the file
    // (#3161, hypothesis 2/3).
    await killProcessTree(child);
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
    throw error;
  }
  return { child, socket, profileDir };
}

/**
 * Run `open` up to `attempts` times, returning the first success and rethrowing
 * the last failure. Kept separate from the launch so the retry policy can be
 * pinned without a browser.
 */
async function withLaunchRetry(open, attempts) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return await open();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Launches a headless browser and returns a small CDP session facade.
 *
 * The session records uncaught exceptions and console errors so a test can
 * assert on them, which is what makes this browser evidence rather than a
 * source-shape assertion.
 *
 * The launch is retried once: a loaded CI runner can miss the endpoint deadline
 * while the same binary starts in a couple of seconds locally, and a transient
 * miss is not a statement about the page under test. The retry only covers the
 * launch legs (endpoint, page target, socket) -- once the socket is open the
 * session is the caller's, and a failure there is a real one.
 *
 * @param {object} [options]
 * @param {number} [options.devToolsTimeoutMs] how long to wait for the DevTools
 *   endpoint before giving up; injectable so a test can pin the failure path
 *   without waiting the full production deadline.
 * @param {number} [options.launchAttempts] how many times to try a full launch;
 *   injectable so a test can pin the retry without a real browser.
 * @returns {Promise<object>} the CDP session facade
 */
async function launchBrowserSession({ devToolsTimeoutMs = DEVTOOLS_ENDPOINT_TIMEOUT_MS, launchAttempts = LAUNCH_ATTEMPTS } = {}) {
  const executable = findBrowser();
  if (!executable) throw new Error('no Chromium-family browser found');

  const session = await withLaunchRetry(
    () => openBrowserSession(executable, devToolsTimeoutMs),
    launchAttempts,
  );
  const { child, socket, profileDir } = session;

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

  let lastEvaluate = '(none)';

  async function evaluate(expression) {
    // Recorded before the round trip: if this evaluate is the one that never
    // returns, the string it was waiting on is the only evidence the teardown
    // has (#3161, acceptance criterion 2).
    lastEvaluate = String(expression).replace(/\s+/g, ' ').trim().slice(0, 200);
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

  /**
   * Close the socket and the launched browser, and bound the whole teardown.
   *
   * The unbounded version of this method was one of the two ways a smoke could
   * come back to the shard runner as a bare timeout with no failing assertion:
   * `child.kill()` signals only the parent pid, so the headless browser's
   * renderer/zygote children -- and the `cat` reading its stderr pipe -- kept
   * the file's process alive past the `exit` event (#3161).
   *
   * Three things bound it now: the tree is collected and signalled, not just the
   * parent; the wait is capped at CLOSE_DEADLINE_MS; and if the cap is reached,
   * the pids still alive, the last evaluate, and any page exceptions are printed
   * before close() returns anyway. A hang is a named, evidenced failure, not a
   * silent one.
   */
  async function close() {
    try { socket.close(); } catch { /* already closing */ }
    const deadline = Date.now() + CLOSE_DEADLINE_MS;
    const { descendants, stragglers } = await killProcessTree(child);
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0) await waitForExit(child, remaining);
    const alive = stragglers.filter(isAlive);
    if (alive.length > 0) {
      console.error(
        `[cdp-browser] close() did not reap the browser tree within ${CLOSE_DEADLINE_MS}ms; `
        + `still alive after SIGKILL: ${alive.join(', ')} (signalled descendants: `
        + `${descendants.length}) (#3161). last evaluate: ${lastEvaluate}`
        + `; page exceptions: ${exceptions.length}, console errors: ${consoleErrors.length}`
        + (exceptions[0] ? `; first exception: ${String(exceptions[0]).slice(0, 300)}` : ''),
      );
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* a leftover profile directory is not a test failure */ }
  }

  return { evaluate, navigate, close, exceptions, consoleErrors, executable };
}

module.exports = {
  launchBrowserSession,
  openBrowserSession,
  withLaunchRetry,
  browserSmokeSkipReason,
  findBrowser,
  firstPageTarget,
  // Exported for the launch-failure unit test (#3240): the DevTools-endpoint
  // wait is the one launch leg that can reject on its own deadline, and a
  // rejecting launch must still reap the child it spawned. Parameterised so the
  // deadline can be shortened in a test, and so the DevToolsActivePort file can
  // be discovered without a real browser.
  waitForDevToolsEndpoint,
  readActivePort,
  // Exported for the teardown unit test (#3161). Kept pure/parameterised so the
  // kill-tree logic can be pinned without launching a browser.
  parseProcessTable,
  collectDescendants,
  killProcessTree,
  CLOSE_DEADLINE_MS,
};
