'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const MemoryStore = require('../lib/memory-store');

// Create a temp directory within the workspace for testing
const tempDir = path.join(__dirname, 'sqlite-test-temp-' + Date.now());
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // Ignore EPERM locks on Windows
  }
});

function getDbPath(name) {
  return path.join(tempDir, `${name}.db`);
}

describe('memory-store-sqlite', () => {

  it('SQLite store persists across new MemoryStore instance', () => {
    const dbPath = getDbPath('persist-reload');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const r1 = store1.store({ content: 'Memory A', workspaceId: 'ws1' });
    const r2 = store1.store({ content: 'Memory B', workspaceId: 'ws1' });

    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    store1.close();

    // Reload with a new instance
    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const listRes = store2.list({ workspaceId: 'ws1' });

    assert.strictEqual(listRes.ok, true);
    assert.strictEqual(listRes.total, 2);
    assert.strictEqual(listRes.memories[0].content, 'Memory A');
    assert.strictEqual(listRes.memories[1].content, 'Memory B');
    store2.close();
  });

  it('list deterministic after reload', () => {
    const dbPath = getDbPath('list-order');
    const originalDate = Date;
    let timeIndex = 0;
    const mockTimes = [
      '2026-06-03T12:00:00.000Z',
      '2026-06-03T12:00:01.000Z',
      '2026-06-03T12:00:02.000Z'
    ];

    global.Date = class extends originalDate {
      constructor() {
        super();
        return new originalDate(mockTimes[timeIndex]);
      }
      toISOString() {
        return mockTimes[timeIndex];
      }
      static now() {
        return new originalDate(mockTimes[timeIndex]).getTime();
      }
    };

    const store1 = new MemoryStore({ useSQLite: true, dbPath });
    
    timeIndex = 0;
    store1.store({ content: 'first' });
    timeIndex = 1;
    store1.store({ content: 'second' });
    timeIndex = 2;
    store1.store({ content: 'third' });

    global.Date = originalDate; // Restore Date
    store1.close();

    // Now load in a new instance and check order
    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const listRes = store2.list();
    assert.strictEqual(listRes.ok, true);
    assert.strictEqual(listRes.total, 3);
    assert.strictEqual(listRes.memories[0].content, 'first');
    assert.strictEqual(listRes.memories[1].content, 'second');
    assert.strictEqual(listRes.memories[2].content, 'third');
    store2.close();
  });

  it('get/read by id after reload', () => {
    const dbPath = getDbPath('get-by-id');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const r = store1.store({ content: 'Fetch me later' });
    const mid = r.memory.memoryId;
    store1.close();

    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const getRes = store2.get(mid);
    assert.strictEqual(getRes.ok, true);
    assert.strictEqual(getRes.memory.content, 'Fetch me later');
    store2.close();
  });

  it('patchMetadata persists and cannot change content', () => {
    const dbPath = getDbPath('patch-metadata');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const r = store1.store({ content: 'fact', metadata: { source: 'A' } });
    const mid = r.memory.memoryId;

    const patchRes = store1.patchMetadata(mid, { source: 'B', confirmed: true });
    assert.strictEqual(patchRes.ok, true);
    store1.close();

    // Reload and check
    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const getRes = store2.get(mid);
    assert.strictEqual(getRes.ok, true);
    assert.strictEqual(getRes.memory.metadata.source, 'B');
    assert.strictEqual(getRes.memory.metadata.confirmed, true);

    // Verify content cannot change
    const invalidPatch = store2.patchMetadata(mid, { content: 'changed fact' });
    assert.strictEqual(invalidPatch.ok, false);
    assert.strictEqual(invalidPatch.error.code, 'IMMUTABLE_CONTENT');

    store2.close();
  });

  it('tombstone persists and default list hides tombstoned memory', () => {
    const dbPath = getDbPath('tombstone-test');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const r1 = store1.store({ content: 'Keep' });
    const r2 = store1.store({ content: 'Delete' });

    const tombRes = store1.tombstone(r2.memory.memoryId);
    assert.strictEqual(tombRes.ok, true);
    store1.close();

    // Reload
    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const listRes = store2.list();
    assert.strictEqual(listRes.total, 1);
    assert.strictEqual(listRes.memories[0].content, 'Keep');

    // includeTombstoned works after reload
    const listAllRes = store2.list({ includeTombstoned: true });
    assert.strictEqual(listAllRes.total, 2);

    store2.close();
  });

  it('supersede persists new memory, old memory state, and link/event metadata', () => {
    const dbPath = getDbPath('supersede-test');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const r1 = store1.store({ content: 'version 1' });
    const r2 = store1.supersede(r1.memory.memoryId, 'version 2');

    assert.strictEqual(r2.ok, true);
    store1.close();

    // Reload
    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const oldMem = store2.get(r1.memory.memoryId);
    const newMem = store2.get(r2.newMemory.memoryId);

    assert.strictEqual(oldMem.memory.status, 'superseded');
    assert.strictEqual(newMem.memory.status, 'active');
    assert.strictEqual(newMem.memory.supersedesMemoryId, r1.memory.memoryId);

    const links = store2.getLinks(r1.memory.memoryId);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].relation, 'supersedes');
    assert.strictEqual(links[0].fromMemoryId, r2.newMemory.memoryId);
    assert.strictEqual(links[0].toMemoryId, r1.memory.memoryId);

    store2.close();
  });

  it('workspace isolation persists across reload', () => {
    const dbPath = getDbPath('workspace-isolation');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    store1.store({ content: 'ws-a memory', workspaceId: 'ws-a' });
    store1.store({ content: 'ws-b memory', workspaceId: 'ws-b' });
    store1.close();

    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const listA = store2.list({ workspaceId: 'ws-a' });
    assert.strictEqual(listA.total, 1);
    assert.strictEqual(listA.memories[0].content, 'ws-a memory');

    const listB = store2.list({ workspaceId: 'ws-b' });
    assert.strictEqual(listB.total, 1);
    assert.strictEqual(listB.memories[0].content, 'ws-b memory');

    store2.close();
  });

  it('same content in two workspaces does not collide', () => {
    const dbPath = getDbPath('same-content-isolation');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const r1 = store1.store({ content: 'Same Fact', workspaceId: 'workspace-1' });
    const r2 = store1.store({ content: 'Same Fact', workspaceId: 'workspace-2' });

    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    // Since workspaces are different, memoryId must be different
    assert.notStrictEqual(r1.memory.memoryId, r2.memory.memoryId);

    store1.close();

    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const get1 = store2.get(r1.memory.memoryId, { workspaceId: 'workspace-1' });
    const get2 = store2.get(r2.memory.memoryId, { workspaceId: 'workspace-2' });

    assert.strictEqual(get1.ok, true);
    assert.strictEqual(get2.ok, true);

    // Cross-get must fail
    const get1in2 = store2.get(r1.memory.memoryId, { workspaceId: 'workspace-2' });
    assert.strictEqual(get1in2.ok, false);

    store2.close();
  });

  it('fails with clear error if SQLite requested but not available (mocked Database as null)', () => {
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'better-sqlite3') {
        throw new Error('Module not found');
      }
      return originalLoad.apply(this, arguments);
    };

    // Clear require cache of memory-store
    const storeKey = require.resolve('../lib/memory-store');
    delete require.cache[storeKey];

    const MemoryStoreMock = require('../lib/memory-store');

    assert.throws(() => {
      new MemoryStoreMock({ useSQLite: true });
    }, /better-sqlite3 is required for SQLite memory storage/);

    // Restore load and require cache
    Module._load = originalLoad;
    delete require.cache[storeKey];
  });

  it('runs safely in in-memory mode when useSQLite is false', () => {
    const store = new MemoryStore({ useSQLite: false });
    const r = store.store({ content: 'pure memory' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(store._db, null);
  });
});
