'use strict';

/**
 * The cdp-browser teardown must reap the whole browser tree (#3161).
 *
 * test/ui-conflict-triage-browser-smoke.test.js was killed at the 240s "heavy
 * file" deadline with no failing assertion and no output: the shard log showed
 * the browser and a `cat` reader still under the test's pid at etime 03:59. The
 * old close() called `child.kill()` -- SIGTERM to the parent pid only -- and
 * waited 5s for `exit`; the headless browser's renderer/zygote children and the
 * pipe reader were never signalled, so the file's process stayed alive long
 * after close() returned.
 *
 * These tests state the property without a browser: a parent that spawns a
 * grandchild, killed through the tree helper, must leave nothing running. A
 * browser is not needed to prove that, and would not reproduce the condition on
 * demand.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  parseProcessTable,
  collectDescendants,
  killProcessTree,
  CLOSE_DEADLINE_MS,
  isAlive,
  isLiveState,
  readProcessState,
} = require('./helpers/cdp-browser');
const { DEFAULT_FILE_TIMEOUT_MS } = require('../scripts/run-test-shard');

test('the process table is parsed from both the POSIX and the Windows shape', () => {
  const posix = parseProcessTable([
    '    1     0 /sbin/init',
    '  240     1 /usr/bin/google-chrome --headless=new --user-data-dir=/tmp/huqan-cdp-xyz',
    '  241   240 cat',
    'not a process line',
    '',
  ].join('\n'));
  assert.deepEqual(posix.map(row => [row.pid, row.ppid]), [[1, 0], [240, 1], [241, 240]]);

  const windows = parseProcessTable([
    '240|1|chrome.exe --headless=new',
    '241|240|cmd.exe',
  ].join('\r\n'));
  assert.deepEqual(windows.map(row => [row.pid, row.ppid]), [[240, 1], [241, 240]]);
});

test('descendants are collected from the browser root only, never a sibling', () => {
  const rows = parseProcessTable([
    '  300     1 /usr/bin/google-chrome --headless=new',
    '  301   300 chrome --type=zygote',
    '  302   301 chrome --type=renderer',
    '  303   300 cat',
    '  400     1 unrelated-server',
    '  401   400 unrelated-worker',
  ].join('\n'));

  const descendants = collectDescendants(rows, 300);
  assert.deepEqual(descendants.sort((a, b) => a - b), [301, 302, 303]);
  assert.ok(!descendants.includes(400), 'a process outside the browser tree must not be collected');

  // A leaf has no descendants; nothing is invented for a pid that is not present.
  assert.deepEqual(collectDescendants(rows, 999), []);
  assert.deepEqual(collectDescendants(rows, 302), []);
});

test('killing the tree leaves no descendant running', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cdp-teardown-'));
  const pidFile = path.join(dir, 'pids.json');
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'fs.writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));',
    'setInterval(() => {}, 1000);',
  ].join('\n');

  const parent = spawn(process.execPath, ['-e', script, pidFile], { stdio: 'ignore' });
  t.after(() => { try { parent.kill('SIGKILL'); } catch { /* already gone */ } });

  const pids = await waitForJson(pidFile);
  assert.ok(pids && pids.grandchild > 0, 'the fixture never reported its grandchild');

  const { descendants, stragglers, probedRows } = await killProcessTree(parent);
  assert.ok(Number.isInteger(probedRows), 'the kill must report how many table rows the probe saw');
  if (probedRows === 0) {
    // Blind probe leg: the CIM query timed out under load and named nothing,
    // so collection could name nothing either. The parentage kill is the
    // backstop, and the straggler and liveness assertions below verify it
    // reaped the tree anyway.
  } else {
    assert.ok(descendants.includes(pids.grandchild),
      `the grandchild (pid ${pids.grandchild}) must be collected and signalled, got ${JSON.stringify(descendants)}`);
  }

  await waitUntilGone(pids.grandchild);
  assert.equal(isAlive(pids.grandchild), false, 'the grandchild outlived the tree kill');
  assert.deepEqual(stragglers, [], `nothing may survive the tree kill, got ${JSON.stringify(stragglers)}`);
  assert.equal(isAlive(parent.pid), false, 'the parent outlived the tree kill');
});

test('a killed-but-unreaped process is not reported as alive', { skip: process.platform === 'win32' }, async () => {
  // The macOS leg of #3327: a SIGKILLed pid keeps answering signal 0 until its
  // parent reaps it, so the signal probe alone called the grandchild a
  // straggler and reddened shard 4. The grandchild's parent is SIGSTOPped
  // below, so it cannot reap and the zombie is guaranteed to persist for the
  // assertions -- deterministic on Linux and macOS, not a race.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cdp-zombie-'));
  const pidFile = path.join(dir, 'pids.json');
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'fs.writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const parent = spawn(process.execPath, ['-e', script, pidFile], { stdio: 'ignore' });
  try {
    const pids = await waitForJson(pidFile);
    assert.ok(pids && pids.grandchild > 0, 'the fixture never reported its grandchild');

    parent.kill('SIGSTOP');
    await waitUntilStopped(parent.pid);
    process.kill(pids.grandchild, 'SIGKILL');
    await waitUntilGone(pids.grandchild);

    // The state reader is the reason the probe is not trusted, through both
    // sources: /proc on Linux, and the ps fallback the macOS runner uses.
    assert.equal(readProcessState(pids.grandchild), 'Z');
    if (process.platform !== 'win32') {
      assert.equal(readProcessState(pids.grandchild, { forceFallback: true }), 'Z');
    }
    assert.equal(isAlive(pids.grandchild), false, 'a zombie must not count as alive');
    assert.equal(isLiveState('Z'), false);
    assert.equal(isLiveState('X'), false);
    assert.equal(isLiveState('S'), true);
  } finally {
    try { parent.kill('SIGCONT'); } catch { /* already gone */ }
    try { parent.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the close deadline stays well inside the heavy-file budget', () => {
  // A bounded teardown is only useful if the bound is smaller than the deadline
  // that would otherwise kill the whole file with no evidence.
  assert.ok(CLOSE_DEADLINE_MS < DEFAULT_FILE_TIMEOUT_MS,
    `${CLOSE_DEADLINE_MS} must be below ${DEFAULT_FILE_TIMEOUT_MS}`);
});

async function waitUntilGone(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function waitUntilStopped(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readProcessState(pid) === 'T') return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function waitForJson(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* still being written */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}
