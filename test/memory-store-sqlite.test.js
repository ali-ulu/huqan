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

  it('query results remain identical after closing and reopening SQLite-backed MemoryStore', () => {
    const dbPath = getDbPath('query-reload');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    store1.store({ content: 'target A', metadata: { priority: 'high' } });
    store1.store({ content: 'other B', metadata: { priority: 'low' } });
    store1.close();

    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const r = store2.query({ metadata: { priority: 'high' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.memories[0].content, 'target A');
    store2.close();
  });

  it('workspace isolation remains true after reload', () => {
    const dbPath = getDbPath('query-workspace-reload');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    store1.store({ content: 'Fact X', workspaceId: 'ws-x' });
    store1.store({ content: 'Fact Y', workspaceId: 'ws-y' });
    store1.close();

    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const rX = store2.query({ workspaceId: 'ws-x' });
    assert.strictEqual(rX.total, 1);
    assert.strictEqual(rX.memories[0].content, 'Fact X');

    const rY = store2.query({ workspaceId: 'ws-y' });
    assert.strictEqual(rY.total, 1);
    assert.strictEqual(rY.memories[0].content, 'Fact Y');
    store2.close();
  });

  it('deleted memory default hiding remains true after reload', () => {
    const dbPath = getDbPath('query-deleted-reload');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const r1 = store1.store({ content: 'persist active' });
    const r2 = store1.store({ content: 'persist deleted' });
    store1.tombstone(r2.memory.memoryId);
    store1.close();

    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    
    // Default hiding
    const rDefault = store2.query();
    assert.strictEqual(rDefault.total, 1);
    assert.strictEqual(rDefault.memories[0].content, 'persist active');

    // With includeDeleted
    const rAll = store2.query({ includeDeleted: true });
    assert.strictEqual(rAll.total, 2);
    store2.close();
  });

  it('links persist after SQLite reload', () => {
    const dbPath = getDbPath('links-persist');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const m1 = store1.store({ content: 'm1' }).memory;
    const m2 = store1.store({ content: 'm2' }).memory;
    const res = store1.linkMemories({ fromMemoryId: m1.memoryId, toMemoryId: m2.memoryId, relation: 'supports' });

    assert.strictEqual(res.ok, true);
    store1.close();

    // Reload
    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const linksRes = store2.queryLinks();
    assert.strictEqual(linksRes.ok, true);
    assert.strictEqual(linksRes.total, 1);
    assert.strictEqual(linksRes.links[0].relation, 'supports');
    store2.close();
  });

  it('timeline/eventsForMemory persist after reload', () => {
    const dbPath = getDbPath('timeline-persist');
    const originalDate = Date;
    let timeIndex = 0;
    const mockTimes = [
      '2026-06-03T12:00:00.000Z',
      '2026-06-03T12:00:05.000Z'
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
    const m1 = store1.store({ content: 'm1' }).memory;
    
    timeIndex = 1;
    store1.patchMetadata(m1.memoryId, { updated: true });

    global.Date = originalDate; // Restore Date
    store1.close();

    // Reload
    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const eventsRes = store2.eventsForMemory(m1.memoryId);
    assert.strictEqual(eventsRes.ok, true);
    assert.strictEqual(eventsRes.total, 2);
    assert.strictEqual(eventsRes.events[0].eventType, 'CREATED');
    assert.strictEqual(eventsRes.events[1].eventType, 'UPDATED');

    const timelineRes = store2.timeline();
    assert.strictEqual(timelineRes.ok, true);
    assert.strictEqual(timelineRes.total, 2);
    store2.close();
  });

  it('workspace isolation survives reload for links and queries', () => {
    const dbPath = getDbPath('ws-isolation-links');
    const store1 = new MemoryStore({ useSQLite: true, dbPath });

    const m1 = store1.store({ content: 'm1', workspaceId: 'ws-a' }).memory;
    const m2 = store1.store({ content: 'm2', workspaceId: 'ws-a' }).memory;
    store1.linkMemories({ fromMemoryId: m1.memoryId, toMemoryId: m2.memoryId, relation: 'supports', workspaceId: 'ws-a' });
    store1.close();

    // Reload
    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const linksA = store2.queryLinks({ workspaceId: 'ws-a' });
    assert.strictEqual(linksA.total, 1);

    const linksB = store2.queryLinks({ workspaceId: 'ws-b' });
    assert.strictEqual(linksB.total, 0);
    store2.close();
  });

  it('transaction rollback test for failed link creation', () => {
    const dbPath = getDbPath('rollback-link');
    const store = new MemoryStore({ useSQLite: true, dbPath });

    const m1 = store.store({ content: 'm1' }).memory;
    const m2 = store.store({ content: 'm2' }).memory;

    // Mock insertEvent.run to throw an error mid-transaction
    const originalRun = store._stmts.insertEvent.run;
    store._stmts.insertEvent.run = () => {
      throw new Error('Simulated event write failure');
    };

    const res = store.linkMemories({
      fromMemoryId: m1.memoryId,
      toMemoryId: m2.memoryId,
      relation: 'supports'
    });

    // Verify it returned failure
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error.code, 'DATABASE_ERROR');

    // Restore run method
    store._stmts.insertEvent.run = originalRun;

    // Close and reload to ensure database is clean and no partial link or event got written
    store.close();

    const store2 = new MemoryStore({ useSQLite: true, dbPath });
    const linksRes = store2.queryLinks();
    assert.strictEqual(linksRes.total, 0);

    const eventsRes = store2.timeline();
    // Timeline should only contain CREATED events of the 2 memories (no LINKED event)
    assert.strictEqual(eventsRes.total, 2);
    assert.ok(!eventsRes.events.some(e => e.eventType === 'LINKED'));

    store2.close();
  });

  describe('PR-M6 SQLite provenance, audit & workspace isolation', () => {
    it('same memoryId across workspaces survives SQLite reload and warmup rebuilds cache correctly', () => {
      const dbPath = getDbPath('dup-id-reload');
      const store1 = new MemoryStore({ useSQLite: true, dbPath });
      
      const memoryId = 'test-dup-id';
      const recordA = {
        memoryId,
        workspaceId: 'ws-a',
        content: { data: 'a' },
        createdAt: '2026-06-03T12:00:00.000Z',
        provenance: {
          provenanceId: 'prov-a',
          sourceRef: 'ref',
          sourceTitle: 'Title',
          sourceType: 'api',
          actor: 'alice',
          timestamp: '2026-06-03T12:00:00.000Z',
          workspaceId: 'ws-a',
          trustPolicyVersion: '1.0.0',
          confidence: 1.0,
        },
        trustPolicyVersion: '1.0.0',
        status: 'active'
      };
      
      const recordB = {
        memoryId,
        workspaceId: 'ws-b',
        content: { data: 'b' },
        createdAt: '2026-06-03T12:00:01.000Z',
        provenance: {
          provenanceId: 'prov-b',
          sourceRef: 'ref',
          sourceTitle: 'Title',
          sourceType: 'api',
          actor: 'bob',
          timestamp: '2026-06-03T12:00:01.000Z',
          workspaceId: 'ws-b',
          trustPolicyVersion: '1.0.0',
          confidence: 1.0,
        },
        trustPolicyVersion: '1.0.0',
        status: 'active'
      };

      store1._db.transaction(() => {
        store1._stmts.upsertMemory.run({
          workspace_id: recordA.workspaceId,
          memory_id: recordA.memoryId,
          kind: 'memory-record',
          content_json: JSON.stringify(recordA.content),
          content_hash: 'hash-a',
          status: recordA.status,
          metadata_json: '{}',
          provenance_json: JSON.stringify(recordA.provenance),
          trust_policy_version: recordA.trustPolicyVersion,
          created_at: recordA.createdAt,
          updated_at: null,
          deleted_at: null,
          supersedes_memory_id: null,
        });

        store1._stmts.upsertMemory.run({
          workspace_id: recordB.workspaceId,
          memory_id: recordB.memoryId,
          kind: 'memory-record',
          content_json: JSON.stringify(recordB.content),
          content_hash: 'hash-b',
          status: recordB.status,
          metadata_json: '{}',
          provenance_json: JSON.stringify(recordB.provenance),
          trust_policy_version: recordB.trustPolicyVersion,
          created_at: recordB.createdAt,
          updated_at: null,
          deleted_at: null,
          supersedes_memory_id: null,
        });
      })();

      store1.close();

      const store2 = new MemoryStore({ useSQLite: true, dbPath });
      assert.strictEqual(store2._memories.size, 2);

      const getA = store2.get(memoryId, { workspaceId: 'ws-a' });
      assert.strictEqual(getA.ok, true);
      assert.strictEqual(getA.memory.content.data, 'a');

      const getB = store2.get(memoryId, { workspaceId: 'ws-b' });
      assert.strictEqual(getB.ok, true);
      assert.strictEqual(getB.memory.content.data, 'b');

      store2.close();
    });

    it('patchMetadata/tombstone/supersede provenance and supersede audit event survive reload', () => {
      const dbPath = getDbPath('prov-audit-reload');
      const store1 = new MemoryStore({ useSQLite: true, dbPath });

      const r1 = store1.store({ content: 'v1', workspaceId: 'ws-a' });
      const mid1 = r1.memory.memoryId;

      const provPatch = {
        provenanceId: 'prov-patch',
        sourceRef: 'patch-ref',
        sourceTitle: 'Title',
        sourceType: 'api',
        actor: 'patcher',
        timestamp: '2026-06-03T12:00:00.000Z',
        workspaceId: 'ws-a',
        trustPolicyVersion: '1.0.0',
        confidence: 1.0,
      };
      store1.patchMetadata(mid1, { status: 'edited' }, { provenance: provPatch });

      const provSupersede = {
        provenanceId: 'prov-super',
        sourceRef: 'super-ref',
        sourceTitle: 'Title',
        sourceType: 'api',
        actor: 'superseder',
        timestamp: '2026-06-03T12:00:05.000Z',
        workspaceId: 'ws-a',
        trustPolicyVersion: '1.0.0',
        confidence: 1.0,
      };
      const superRes = store1.supersede(mid1, 'v2', { provenance: provSupersede });
      const mid2 = superRes.newMemory.memoryId;

      const provTombstone = {
        provenanceId: 'prov-tomb',
        sourceRef: 'tomb-ref',
        sourceTitle: 'Title',
        sourceType: 'api',
        actor: 'tombstoner',
        timestamp: '2026-06-03T12:00:10.000Z',
        workspaceId: 'ws-a',
        trustPolicyVersion: '1.0.0',
        confidence: 1.0,
      };
      store1.tombstone(mid2, { provenance: provTombstone });

      store1.close();

      const store2 = new MemoryStore({ useSQLite: true, dbPath });

      const events1 = store2.getEvents(mid1);
      const updateEvent = events1.find(e => e.eventType === 'UPDATED' && e.details.action === 'supersede');
      assert.ok(updateEvent);
      assert.strictEqual(updateEvent.provenance.actor, 'superseder');
      assert.strictEqual(updateEvent.details.supersededByMemoryId, mid2);
      assert.strictEqual(updateEvent.details.previousStatus, 'active');
      assert.strictEqual(updateEvent.details.newStatus, 'superseded');

      const events2 = store2.getEvents(mid2);
      const tombstoneEvent = events2.find(e => e.eventType === 'TOMBSTONE');
      assert.ok(tombstoneEvent);
      assert.strictEqual(tombstoneEvent.provenance.actor, 'tombstoner');

      store2.close();
    });

    it('no cross-workspace event/link leakage after reload', () => {
      const dbPath = getDbPath('cross-ws-reload');
      const store1 = new MemoryStore({ useSQLite: true, dbPath });

      const m1 = store1.store({ content: 'm1', workspaceId: 'ws-a' }).memory;
      const m2 = store1.store({ content: 'm2', workspaceId: 'ws-a' }).memory;
      store1.linkMemories({ fromMemoryId: m1.memoryId, toMemoryId: m2.memoryId, relation: 'supports', workspaceId: 'ws-a' });

      const m3 = store1.store({ content: 'm3', workspaceId: 'ws-b' }).memory;

      store1.close();

      const store2 = new MemoryStore({ useSQLite: true, dbPath });

      const linksA = store2.queryLinks({ workspaceId: 'ws-a' });
      assert.strictEqual(linksA.total, 1);

      const linksB = store2.queryLinks({ workspaceId: 'ws-b' });
      assert.strictEqual(linksB.total, 0);

      const timelineA = store2.timeline({ workspaceId: 'ws-a' });
      assert.strictEqual(timelineA.total, 3);

      const timelineB = store2.timeline({ workspaceId: 'ws-b' });
      assert.strictEqual(timelineB.total, 1);

      store2.close();
    });

    it('transaction rollback test for failed supersede operation', () => {
      const dbPath = getDbPath('rollback-supersede');
      const store = new MemoryStore({ useSQLite: true, dbPath });

      const r1 = store.store({ content: 'v1' });
      const mid1 = r1.memory.memoryId;

      let callCount = 0;
      const originalRun = store._stmts.insertEvent.run;
      store._stmts.insertEvent.run = function() {
        callCount++;
        if (callCount >= 2) {
          throw new Error('Simulated event write failure during supersede');
        }
        return originalRun.apply(this, arguments);
      };

      assert.throws(() => {
        store.supersede(mid1, 'v2');
      }, /Simulated event write failure during supersede/);

      store._stmts.insertEvent.run = originalRun;

      const oldMemCached = store.get(mid1).memory;
      assert.strictEqual(oldMemCached.status, 'active');

      store.close();

      const store2 = new MemoryStore({ useSQLite: true, dbPath });
      const oldMemDB = store2.get(mid1).memory;
      assert.strictEqual(oldMemDB.status, 'active');

      const timeline = store2.timeline();
      assert.strictEqual(timeline.total, 1);

      store2.close();
    });
  });
});
