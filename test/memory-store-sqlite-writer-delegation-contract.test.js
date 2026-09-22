'use strict';

// #2129: SQLite write path (schema, statements, per-operation persist) lives
// in lib/memory-store-sqlite-writer.js. The store keeps handle/collection
// ownership and delegates. No cycle back: the writer receives the store as
// an argument and never requires it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store-sqlite-writer.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('#2129: SQLite write path is delegated to the writer module', () => {
  assert.ok(
    storeSource.includes("require('./memory-store-sqlite-writer')"),
    'lib/memory-store.js imports the sqlite writer',
  );
  for (const name of [
    'initMemorySchema',
    'createMemoryStmts',
    'openMemoryDatabase',
    'persistStoreWrite',
    'persistLinkMemories',
    'persistPatchMetadata',
    'persistTombstone',
    'persistSupersede',
    'persistImportMemory',
  ]) {
    assert.ok(storeSource.includes(name), `store references ${name}`);
    assert.ok(delegateCode.includes(name), `writer defines ${name}`);
  }
});

test('#2129: no SQL stays in the store facade', () => {
  for (const banned of [
    'CREATE TABLE',
    'CREATE INDEX',
    'upsertMemory',
    'insertEvent',
    'insertLink',
    '.prepare(`',
  ]) {
    assert.ok(!storeSource.includes(banned), `store must not contain ${banned}`);
  }
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'writer has no cycle back into memory-store');
});

test('#2129: writer round-trips every mutation through SQLite', () => {
  delete require.cache[require.resolve('../lib/memory-store')];
  const MemoryStore = require('../lib/memory-store');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2129-'));
  const store = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 's.db') });

  const stored = store.store({ content: 'writer delegation' });
  assert.equal(stored.ok, true);
  const patched = store.patchMetadata(stored.memory.memoryId, { k: 'v' });
  assert.equal(patched.ok, true);
  const linked = store.store({ content: 'second' });
  const linkRes = store.linkMemories({ fromMemoryId: stored.memory.memoryId, toMemoryId: linked.memory.memoryId, relation: 'related_to' });
  assert.equal(linkRes.ok, true);
  assert.equal(store.queryLinks({}).total, 1);
  const sup = store.supersede(stored.memory.memoryId, 'v2');
  assert.equal(sup.ok, true);
  const tomb = store.tombstone(linked.memory.memoryId);
  assert.equal(tomb.ok, true);

  const fresh = new MemoryStore({ useSQLite: true, dbPath: path.join(dir, 's.db') });
  assert.equal(fresh.get(sup.newMemory.memoryId).ok, true);
  assert.equal(fresh.get(linked.memory.memoryId).memory.status, 'deleted');
  assert.ok(fresh.timeline({}).total >= 5);
  store.close();
  fresh.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
