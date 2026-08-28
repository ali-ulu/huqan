'use strict';

/**
 * #1674: a consumed MCP operator capability must stay consumed across a
 * restart.
 *
 * Capabilities are valid for up to MAX_TTL_MS (five minutes). While the
 * consumed-nonce set lived only in process memory, a restart inside that
 * window -- a crash, a redeploy, or simply a second worker that never handled
 * the first request -- forgot the nonce and the same single-use capability was
 * accepted again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const {
  canonicalActionHash,
  createMcpOperatorCapability,
  verifyMcpOperatorCapability,
} = require('../lib/mcp-operator-capability');
const {
  SWEEP_GRACE_MS,
  createDurableCapabilityNonceStore,
  nonceFileName,
  resolveCapabilityNonceDirectory,
} = require('../lib/mcp-capability-nonce-store');

const SECRET = 'operator-secret-for-capability-tests';
const BINDING = { tool: 'huqan.approve', workspaceId: 'workspace-a', approvalId: 'approval-1', runId: null };

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cap-nonce-'));
}

function issue(now = Date.now()) {
  const actionHash = canonicalActionHash({ ...BINDING, arguments: { approvalId: 'approval-1' } });
  const capability = createMcpOperatorCapability({ secret: SECRET, ...BINDING, actionHash, now });
  return { capability, expected: { ...BINDING, actionHash } };
}

function verify(capability, expected, nonceStore, now = Date.now()) {
  return verifyMcpOperatorCapability({ secret: SECRET, capability, expected, nonceStore, now });
}

test('a capability is single-use within one process', () => {
  const store = createDurableCapabilityNonceStore({ directory: makeDir() });
  const { capability, expected } = issue();
  assert.equal(verify(capability, expected, store).ok, true);
  const replay = verify(capability, expected, store);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'capability.replayed');
});

test('a capability consumed before a restart is refused after it', () => {
  const directory = makeDir();
  const { capability, expected } = issue();

  const beforeRestart = createDurableCapabilityNonceStore({ directory });
  assert.equal(verify(capability, expected, beforeRestart).ok, true);

  // A fresh store over the same directory is what a restarted process has:
  // no in-memory history at all, only what reached disk.
  const afterRestart = createDurableCapabilityNonceStore({ directory });
  const replay = verify(capability, expected, afterRestart);
  assert.equal(replay.ok, false, 'a restart must not revive a spent capability');
  assert.equal(replay.reason, 'capability.replayed');
});

test('a process-local Map does lose the record across a restart (the behaviour being replaced)', () => {
  const { capability, expected } = issue();
  assert.equal(verify(capability, expected, new Map()).ok, true);
  assert.equal(verify(capability, expected, new Map()).ok, true);
});

test('exactly one of many concurrent consumers wins', () => {
  const store = createDurableCapabilityNonceStore({ directory: makeDir() });
  const { capability, expected } = issue();
  const outcomes = Array.from({ length: 32 }, () => verify(capability, expected, store).ok);
  assert.equal(outcomes.filter(Boolean).length, 1);
});

test('concurrent worker processes sharing a directory admit the nonce once', async () => {
  const directory = makeDir();
  const workerPath = path.join(directory, 'worker.js');
  fs.writeFileSync(workerPath, `
    const { createDurableCapabilityNonceStore } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'mcp-capability-nonce-store.js'))});
    const store = createDurableCapabilityNonceStore({ directory: process.argv[2] });
    process.send(store.consume(process.argv[3], Math.floor(Date.now() / 1000) + 120, Date.now()));
  `);

  const nonce = 'shared-nonce-across-workers';
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = fork(workerPath, [directory, nonce], { stdio: 'ignore' });
    let value = null;
    child.on('message', message => { value = message; });
    child.on('error', reject);
    child.on('exit', () => resolve(value));
  })));

  assert.equal(results.filter(result => result === true).length, 1, `exactly one worker may win: ${JSON.stringify(results)}`);
});

test('expired records are swept, and unexpired ones are kept', () => {
  const directory = makeDir();
  const store = createDurableCapabilityNonceStore({ directory });
  const now = Date.now();

  const expiredExp = Math.floor((now - SWEEP_GRACE_MS - 60_000) / 1000);
  const liveExp = Math.floor((now + 120_000) / 1000);
  assert.equal(store.consume('expired-nonce', expiredExp, now), true);
  assert.equal(store.consume('live-nonce', liveExp, now), true);

  assert.equal(store.sweep(now), 1);
  assert.equal(fs.existsSync(path.join(directory, nonceFileName('expired-nonce'))), false);
  assert.equal(fs.existsSync(path.join(directory, nonceFileName('live-nonce'))), true);
});

test('a record inside the sweep grace period is not removed', () => {
  const directory = makeDir();
  const store = createDurableCapabilityNonceStore({ directory });
  const now = Date.now();
  // Expired one second ago: no longer usable, but a worker with a slightly
  // slower clock might still be inside its window.
  store.consume('just-expired', Math.floor((now - 1000) / 1000), now);
  assert.equal(store.sweep(now), 0);
  assert.equal(fs.existsSync(path.join(directory, nonceFileName('just-expired'))), true);
});

test('an unwritable durable store fails closed', () => {
  const store = createDurableCapabilityNonceStore({
    directory: makeDir(),
    fileSystem: {
      mkdirSync() { throw new Error('read-only filesystem'); },
      writeFileSync() { throw new Error('read-only filesystem'); },
      readdirSync() { throw new Error('read-only filesystem'); },
      readFileSync() { throw new Error('read-only filesystem'); },
      rmSync() {},
    },
  });
  const { capability, expected } = issue();
  const result = verify(capability, expected, store);
  assert.equal(result.ok, false, 'an unavailable store must not accept the capability');
  assert.equal(result.reason, 'capability.replayed');
});

test('a store whose consume() throws is refused rather than trusted', () => {
  const { capability, expected } = issue();
  const result = verify(capability, expected, { consume() { throw new Error('boom'); } });
  assert.equal(result.ok, false);
});

test('a nonce never seen before is admitted after a restart (normal continuation)', () => {
  const directory = makeDir();
  const first = issue();
  assert.equal(verify(first.capability, first.expected, createDurableCapabilityNonceStore({ directory })).ok, true);

  const second = issue();
  assert.equal(
    verify(second.capability, second.expected, createDurableCapabilityNonceStore({ directory })).ok,
    true,
    'a fresh capability must still work after a restart',
  );
});

test('nonce file names cannot escape the directory', () => {
  const directory = makeDir();
  const store = createDurableCapabilityNonceStore({ directory });
  const hostile = '../../../../etc/huqan-escape';
  assert.equal(store.consume(hostile, Math.floor(Date.now() / 1000) + 60, Date.now()), true);
  assert.deepEqual(fs.readdirSync(directory), [nonceFileName(hostile)]);
  assert.match(nonceFileName(hostile), /^[0-9a-f]{64}\.nonce$/);
});

test('the default nonce directory sits beside the memory store and is overridable', () => {
  const beside = resolveCapabilityNonceDirectory({ memoryPath: '/srv/huqan/data/memory.json' }, {});
  assert.equal(beside, path.resolve('/srv/huqan/data/.huqan-capability-nonces'));

  const overridden = resolveCapabilityNonceDirectory({ capabilityNonceDir: '/var/lib/huqan/nonces' }, {});
  assert.equal(overridden, path.resolve('/var/lib/huqan/nonces'));
});
