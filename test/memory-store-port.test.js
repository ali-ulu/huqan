'use strict';

// Characterization of the MemoryStorePort backends (#2906). MemoryStore has
// three: SQLite (record authority when a handle is open), JSON (whole-file
// atomic rewrite per mutation) and memory (no durability). Each test pins one
// behavior a backend owns, so routing a call to the wrong backend, or updating
// the in-memory mirror before persistence succeeds (#761), turns a test red.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const MemoryStore = require('../lib/memory-store');
const { MEMORY_STORE_PORT_METHODS } = require('../lib/memory-store-port');
const { isSqliteAvailable } = require('../lib/sqlite-persistence-validation');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    open(options) {
      const store = new MemoryStore(options);
      stores.push(store);
      return store;
    },
  };
}

function jsonOptions(dir) {
  return { useSQLite: false, memoryPath: path.join(dir, 'memory-store.json') };
}

function sqliteOptions(dir) {
  return { useSQLite: true, dbPath: path.join(dir, 'memory-store.db') };
}

function skipWithoutSqlite(t) {
  if (isSqliteAvailable()) return false;
  t.skip('better-sqlite3 is unavailable');
  return true;
}

function packageWithLink(workspaceId) {
  const source = new MemoryStore({});
  const a = source.store({ content: 'import a', workspaceId });
  const b = source.store({ content: 'import b', workspaceId });
  source.linkMemories({ fromMemoryId: a.memory.memoryId, toMemoryId: b.memory.memoryId, relation: 'related_to', workspaceId });
  const exported = source.exportPackage({ workspaceId });
  assert.equal(exported.ok, true);
  return exported.package;
}

test('MemoryStorePort names its contract and reports the backend per call', (t) => {
  const env = tempDir(t, 'huqan-memory-port-contract-');
  const json = env.open(jsonOptions(env.dir));
  const memory = env.open({});

  assert.ok(Object.isFrozen(MEMORY_STORE_PORT_METHODS));
  for (const method of MEMORY_STORE_PORT_METHODS) {
    assert.equal(typeof json._storePort[method], 'function', `port must implement ${method}`);
  }
  assert.ok(Object.isFrozen(json._storePort));
  assert.equal(json._storePort.backend(), 'json');
  assert.equal(memory._storePort.backend(), 'memory');

  if (skipWithoutSqlite(t)) return;
  const sqlite = env.open(sqliteOptions(env.dir));
  assert.equal(sqlite._storePort.backend(), 'sqlite');
  sqlite.close();
  assert.equal(sqlite._storePort.backend(), 'memory');
  sqlite.reopen();
  assert.equal(sqlite._storePort.backend(), 'sqlite');
});

test('save() and load() report the backend they ran against', (t) => {
  const env = tempDir(t, 'huqan-memory-port-reports-');
  const json = env.open(jsonOptions(env.dir));
  json.store({ content: 'reported' });
  assert.deepEqual(json.save(), { ok: true, skipped: false, persistent: true, backend: 'json' });
  assert.deepEqual(json.load(), { ok: true, skipped: false, persistent: true, loaded: 1, backend: 'json' });

  const memory = env.open({});
  const saved = memory.save();
  assert.equal(saved.ok, false);
  assert.equal(saved.error.code, 'PERSISTENCE_DISABLED');
  assert.deepEqual(memory.load(), { ok: true, skipped: true, persistent: false, loaded: 0, backend: 'memory' });

  if (skipWithoutSqlite(t)) return;
  const sqlite = env.open(sqliteOptions(env.dir));
  assert.deepEqual(sqlite.save(), { ok: true, skipped: true, persistent: true, backend: 'sqlite' });
  assert.deepEqual(sqlite.load(), { ok: true, skipped: true, persistent: true, loaded: 0, backend: 'sqlite' });
});

test('JSON backend rewrites the file on every mutation and a new store reads it back', (t) => {
  const env = tempDir(t, 'huqan-memory-port-json-roundtrip-');
  const writer = env.open(jsonOptions(env.dir));
  const first = writer.store({ content: 'first', workspaceId: 'ws' });
  const second = writer.store({ content: 'second', workspaceId: 'ws' });
  writer.linkMemories({ fromMemoryId: first.memory.memoryId, toMemoryId: second.memory.memoryId, relation: 'related_to', workspaceId: 'ws' });
  writer.patchMetadata(first.memory.memoryId, { k: 'v' }, { workspaceId: 'ws' });
  const third = writer.store({ content: 'third', workspaceId: 'ws' });
  writer.tombstone(third.memory.memoryId, { workspaceId: 'ws' });

  const reader = env.open(jsonOptions(env.dir));
  assert.equal(reader.get(first.memory.memoryId, { workspaceId: 'ws' }).memory.metadata.k, 'v');
  assert.equal(reader.get(third.memory.memoryId, { workspaceId: 'ws' }).memory.status, 'deleted');
  assert.equal(reader.queryLinks({ workspaceId: 'ws' }).total, 1);
});

test('JSON backend write failure leaves the in-memory mirror untouched', (t) => {
  const env = tempDir(t, 'huqan-memory-port-json-fault-');
  const store = env.open({ useSQLite: false, memoryPath: path.join(env.dir, 'missing', 'memory-store.json') });

  const result = store.store({ content: 'never persisted' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PERSISTENCE_ERROR');
  assert.equal(result.error.operation, 'store');
  assert.equal(store.list({}).total, 0, 'the mirror must not hold a record the file does not');
});

test('JSON backend: a corrupt file throws at construction and reports on load()', (t) => {
  const env = tempDir(t, 'huqan-memory-port-json-corrupt-');
  const options = jsonOptions(env.dir);
  const store = env.open(options);
  store.store({ content: 'kept' });

  fs.writeFileSync(options.memoryPath, '{"version":');
  assert.throws(() => new MemoryStore(options));
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.operation, 'load');
});

test('JSON backend persists an import as one rewrite and restores the mirror when it fails', (t) => {
  const env = tempDir(t, 'huqan-memory-port-json-import-');
  const pkg = packageWithLink('ws');
  const options = jsonOptions(env.dir);
  const store = env.open(options);

  const imported = store.importPackage(pkg, { targetWorkspaceId: 'ws' });
  assert.equal(imported.ok, true);
  const reader = env.open(options);
  assert.equal(reader.list({ workspaceId: 'ws' }).total, 2);
  assert.equal(reader.queryLinks({ workspaceId: 'ws' }).total, 1);

  const failing = env.open({ useSQLite: false, memoryPath: path.join(env.dir, 'missing', 'memory-store.json') });
  const rejected = failing.importPackage(pkg, { targetWorkspaceId: 'ws' });
  assert.equal(rejected.ok, false);
  assert.equal(failing.list({ workspaceId: 'ws' }).total, 0, 'a failed import must not leave records behind');
});

test('memory backend keeps records in process and writes nothing', (t) => {
  const env = tempDir(t, 'huqan-memory-port-memory-');
  const store = env.open({});
  assert.equal(store.store({ content: 'volatile' }).ok, true);
  assert.equal(store.list({}).total, 1);
  assert.deepEqual(fs.readdirSync(env.dir), []);
});

test('SQLite backend rolls back a multi-row write and leaves the mirror untouched', (t) => {
  if (skipWithoutSqlite(t)) return;
  const env = tempDir(t, 'huqan-memory-port-sqlite-rollback-');
  const store = env.open(sqliteOptions(env.dir));

  const fault = new Error('event insert failed');
  const original = store._stmts;
  store._stmts = { ...original, insertEvent: { run() { throw fault; } } };
  const result = store.store({ content: 'rolled back' });
  store._stmts = original;

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PERSISTENCE_ERROR');
  assert.equal(result.error.message, 'event insert failed');
  assert.equal(store.list({}).total, 0, 'mirror updated only after persistence succeeds');
  const reader = env.open(sqliteOptions(env.dir));
  assert.equal(reader.list({}).total, 0, 'the memory row must roll back with the failed event row');
});

test('SQLite backend persists imported memories, events and links', (t) => {
  if (skipWithoutSqlite(t)) return;
  const env = tempDir(t, 'huqan-memory-port-sqlite-import-');
  const pkg = packageWithLink('ws');
  const store = env.open(sqliteOptions(env.dir));

  const imported = store.importPackage(pkg, { targetWorkspaceId: 'ws' });
  assert.equal(imported.ok, true);
  assert.ok(imported.imported.events > 0);

  const reader = env.open(sqliteOptions(env.dir));
  assert.equal(reader.list({ workspaceId: 'ws' }).total, 2);
  assert.equal(reader.queryLinks({ workspaceId: 'ws' }).total, 1);
  assert.ok(reader.timeline({ workspaceId: 'ws' }).total >= imported.imported.events);
});

test('SQLite backend does not touch the JSON file even when a memoryPath is given', (t) => {
  if (skipWithoutSqlite(t)) return;
  const env = tempDir(t, 'huqan-memory-port-sqlite-nojson-');
  const memoryPath = path.join(env.dir, 'memory-store.json');
  const store = env.open({ ...sqliteOptions(env.dir), memoryPath });
  assert.equal(store.store({ content: 'sqlite only' }).ok, true);
  assert.equal(fs.existsSync(memoryPath), false);
});

test('SQLite backend persists link, patch, supersede and tombstone rows', (t) => {
  if (skipWithoutSqlite(t)) return;
  const env = tempDir(t, 'huqan-memory-port-sqlite-mutations-');
  const writer = env.open(sqliteOptions(env.dir));
  const first = writer.store({ content: 'first', workspaceId: 'ws' });
  const second = writer.store({ content: 'second', workspaceId: 'ws' });
  const third = writer.store({ content: 'third', workspaceId: 'ws' });
  assert.equal(writer.linkMemories({ fromMemoryId: first.memory.memoryId, toMemoryId: second.memory.memoryId, relation: 'related_to', workspaceId: 'ws' }).ok, true);
  assert.equal(writer.patchMetadata(first.memory.memoryId, { k: 'v' }, { workspaceId: 'ws' }).ok, true);
  const superseded = writer.supersede(second.memory.memoryId, 'second v2', { workspaceId: 'ws' });
  assert.equal(superseded.ok, true);
  assert.equal(writer.tombstone(third.memory.memoryId, { workspaceId: 'ws' }).ok, true);

  const reader = env.open(sqliteOptions(env.dir));
  assert.equal(reader.get(first.memory.memoryId, { workspaceId: 'ws' }).memory.metadata.k, 'v');
  assert.equal(reader.get(second.memory.memoryId, { workspaceId: 'ws' }).memory.status, 'superseded');
  assert.equal(reader.get(superseded.newMemory.memoryId, { workspaceId: 'ws' }).ok, true);
  assert.equal(reader.get(third.memory.memoryId, { workspaceId: 'ws' }).memory.status, 'deleted');
  // queryLinks hides links whose endpoint is no longer active unless asked to
  // include them; with includeDeleted it counts every row (#3208: the SQLite
  // backend keeps no link array to count).
  assert.equal(reader.queryLinks({ workspaceId: 'ws', includeDeleted: true, limit: null }).total, 2,
    'related_to link plus the supersede link');
});
