'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MemoryStore = require('../lib/memory-store');

test('2348: memory store exposes a documented public makeMemoryKey', () => {
  assert.equal(typeof MemoryStore.prototype.makeMemoryKey, 'function', 'makeMemoryKey must be public surface');
  assert.equal(typeof MemoryStore.prototype._makeMemoryKey, 'function', 'private delegate retained for legacy callers');
});

test('2348: makeMemoryKey trims both parts and preserves the workspace case', () => {
  const makeMemoryKey = MemoryStore.prototype.makeMemoryKey;
  assert.equal(makeMemoryKey.call({}, ' WS-1 ', '  mem-1  '), 'WS-1:mem-1');
});

// #3208: warmup no longer copies rows into a Map; the SQLite-backed
// collection builds its cache keys, and it must use the public builder too.
test('2348: the SQLite memory collection keys records through the public key builder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2348-'));
  const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 'memory.db') });
  try {
    const stored = store.store({ content: 'hello', workspaceId: 'WS-1' }).memory;
    store.close();
    store.reopen();
    const calls = [];
    const original = store.makeMemoryKey.bind(store);
    store.makeMemoryKey = (workspaceId, memoryId) => {
      calls.push(`${workspaceId}:${memoryId}`);
      return original(workspaceId, memoryId);
    };
    assert.equal(store._memories.size, 1);
    assert.equal(store.get(stored.memoryId, { workspaceId: 'WS-1' }).memory.memoryId, stored.memoryId);
    assert.ok(calls.includes(`WS-1:${stored.memoryId}`),
      'the collection must call store.makeMemoryKey, not the private underscore method');
  } finally {
    store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
});
