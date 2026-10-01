'use strict';

/**
 * A launch that fails must reap the browser it spawned (#3240).
 *
 * test/ui-conflict-triage-browser-smoke.test.js was killed by the 240s
 * heavy-file deadline with no failing assertion. The shard log shows the whole
 * `before` hook finishing in one burst ~20s after the server printed its URL --
 * the CONNECT_TIMEOUT_MS deadline -- while 12 browser processes (chrome, its
 * zygotes and renderers, and a `cat` on the stderr pipe) were still alive under
 * the file's pid four minutes later.
 *
 * launchBrowserSession already reaped the child when `connect`/`firstPageTarget`
 * failed, but the `waitForDevToolsEndpoint` await sat outside that try. When the
 * browser never announced a DevTools endpoint it rejected there and the child
 * tree leaked, which is what kept the file's process alive. These tests state
 * the property without a real browser: a launch that rejects before it reaches
 * DevTools must still kill the child it spawned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { waitForDevToolsEndpoint, launchBrowserSession } = require('./helpers/cdp-browser');

test('a child that never announces a DevTools endpoint rejects on the deadline', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => waitForDevToolsEndpoint(child, { timeoutMs: 300 }),
      /did not report a DevTools endpoint in 300ms/,
      'the endpoint wait must name its own deadline instead of hanging',
    );
    assert.ok(Date.now() - startedAt < 10_000, 'the endpoint wait must be bounded by its own deadline');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('a launch that never reaches DevTools reaps the browser it spawned', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cdp-launch-'));
  const pidFile = path.join(dir, 'pid');
  // A stand-in browser: stays alive, ignores the Chrome flags, and never prints
  // the `ws://.../devtools/browser/...` line waitForDevToolsEndpoint looks for.
  const fake = path.join(dir, 'fake-chrome');
  fs.writeFileSync(fake, [
    '#!/usr/bin/env node',
    "require('node:fs').writeFileSync(process.env.FAKE_CHROME_PIDFILE, String(process.pid));",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o755 });

  const previousChrome = process.env.HUQAN_CHROME;
  const previousPidFile = process.env.FAKE_CHROME_PIDFILE;
  process.env.HUQAN_CHROME = fake;
  process.env.FAKE_CHROME_PIDFILE = pidFile;
  t.after(() => {
    if (previousChrome === undefined) delete process.env.HUQAN_CHROME; else process.env.HUQAN_CHROME = previousChrome;
    if (previousPidFile === undefined) delete process.env.FAKE_CHROME_PIDFILE; else process.env.FAKE_CHROME_PIDFILE = previousPidFile;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  });

  await assert.rejects(
    () => launchBrowserSession({ devToolsTimeoutMs: 500 }),
    /did not report a DevTools endpoint in 500ms/,
    'the launch must reject rather than hang',
  );

  const pid = await waitForPid(pidFile);
  assert.ok(pid > 0, 'the stand-in browser never reported its pid');
  await waitUntilGone(pid);
  assert.equal(isAlive(pid), false, 'the launch failure leaked the browser it spawned (#3240)');
});

function isAlive(pid) {
  // A killed process with no living parent is reparented and left as a zombie
  // until some init reaps it; a zombie answers signal 0, so the bare probe would
  // report a dead process as alive. Read the state where the kernel exposes it.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}

async function waitUntilGone(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function waitForPid(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fs.existsSync(file)) return Number(fs.readFileSync(file, 'utf8')); } catch { /* still being written */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return 0;
}
