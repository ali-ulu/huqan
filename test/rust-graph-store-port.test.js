'use strict';

// RustGraph persists through a GraphStorePort adapter (#2906). The process is
// an accelerator, not a second graph authority: on fallback the adapter must
// hand persistence to the JavaScript Graph's own port, and on the process path
// it must keep the exact save/load wire commands and result shape.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const RustGraph = require('../rustGraph');
const { RUST_GRAPH_STORE_PORT_METHODS } = require('../lib/rust-graph-store-port');

function withMissingBinary(fn) {
  const originalExistsSync = fs.existsSync;
  fs.existsSync = () => false;
  return Promise.resolve()
    .then(fn)
    .finally(() => { fs.existsSync = originalExistsSync; });
}

test('RustGraph exposes a frozen store port with the named contract', () => {
  const bridge = new RustGraph({ memoryPath: 'virtual-memory.json' });
  assert.ok(Object.isFrozen(bridge._storePort));
  assert.deepEqual([...RUST_GRAPH_STORE_PORT_METHODS].sort(), ['backend', 'load', 'save']);
  for (const method of RUST_GRAPH_STORE_PORT_METHODS) {
    assert.equal(typeof bridge._storePort[method], 'function', `port must implement ${method}`);
  }
  assert.equal(bridge._storePort.backend(), 'unstarted');
});

test('fallback persistence goes to the JavaScript Graph and never to the process', async () => {
  const calls = [];
  const fallback = {
    addNode() { return {}; },
    save(...args) { calls.push(['save', args]); return 'ignored'; },
    load(...args) { calls.push(['load', args]); return 'ignored'; },
  };
  const bridge = new RustGraph({ memoryPath: 'virtual-memory.json', createFallbackGraph: () => fallback });
  bridge.send = () => { throw new Error('fallback persistence must not reach the process'); };

  await withMissingBinary(async () => {
    bridge.start();
    assert.equal(bridge._storePort.backend(), 'js-fallback');
    assert.equal(await bridge.save('other.json'), undefined);
    assert.equal(await bridge.load('other.json'), undefined);
  });
  // The fallback Graph owns its own path; the Rust memPath override is not forwarded.
  assert.deepEqual(calls, [['save', []], ['load', []]]);
});

test('first save and load initialize the missing-binary fallback before persisting', async () => {
  const calls = [];
  const fallback = {
    save() { calls.push('save'); },
    load() { calls.push('load'); },
  };

  await withMissingBinary(async () => {
    const saving = new RustGraph({ memoryPath: 'virtual-memory.json', createFallbackGraph: () => fallback });
    assert.equal(saving._storePort.backend(), 'unstarted');
    assert.equal(await saving.save(), undefined);
    assert.equal(saving._storePort.backend(), 'js-fallback');

    const loading = new RustGraph({ memoryPath: 'virtual-memory.json', createFallbackGraph: () => fallback });
    assert.equal(loading._storePort.backend(), 'unstarted');
    assert.equal(await loading.load(), undefined);
    assert.equal(loading._storePort.backend(), 'js-fallback');
  });
  assert.deepEqual(calls, ['save', 'load']);
});

test('process persistence sends the save/load wire commands and returns res.ok', async () => {
  const sent = [];
  const replies = [{ ok: true }, { ok: false }, null];
  const bridge = new RustGraph({ memoryPath: 'default-memory.json' });
  bridge.start = () => {}; // This test supplies the process reply through send().
  bridge.send = async (cmd) => { sent.push(cmd); return replies.shift(); };

  assert.equal(await bridge.save(), true);
  assert.equal(await bridge.load('explicit.json'), false);
  assert.equal(await bridge.save(), null, 'a missing reply is passed through, not coerced');
  assert.deepEqual(sent, [
    { cmd: 'save', path: 'default-memory.json' },
    { cmd: 'load', path: 'explicit.json' },
    { cmd: 'save', path: 'default-memory.json' },
  ]);
});

test('a process timeout reaches the caller as a false result, not a throw', async () => {
  const bridge = new RustGraph({ memoryPath: 'default-memory.json', requestTimeoutMs: 5 });
  bridge._proc = {
    stdin: { write() {}, ref() {}, unref() {} },
    stdout: { ref() {}, unref() {} },
    ref() {},
    unref() {},
  };

  // The request timer is unref()'d by design; hold the loop open for the test.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal(await bridge.save(), false);
    assert.equal(await bridge.load(), false);
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(bridge._pending.size, 0, 'timed-out requests must not stay pending');
});
