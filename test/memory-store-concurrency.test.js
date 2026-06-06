'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MemoryStore = require('../lib/memory-store');

function getDbPath(label) {
  return path.join(
    os.tmpdir(),
    `axiom-pr-s3-${label}-${process.pid}-${Date.now()}.db`
  );
}

function cleanupDb(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

function mockStatementThrow(stmts, key, message) {
  const original = stmts[key].run;
  stmts[key].run = () => {
    throw new Error(message);
  };
  return () => { stmts[key].run = original; };
}

function newStore(label, opts = {}) {
  return new MemoryStore({ useSQLite: true, dbPath: getDbPath(label || 'conc'), ...opts });
}

describe('PR-S3 transaction safety & concurrency', () => {
  describe('PERSISTENCE_ERROR standardization (both modes)', () => {
    test('store: SQLite write failure returns PERSISTENCE_ERROR/store', () => {
      const dbPath = getDbPath('err-store-sql');
      try {
        const store = newStore('err-store-sql', { dbPath });
        const restore = mockStatementThrow(store._stmts, 'upsertMemory', 'simulated upsert failure');
        const res = store.store({ content: { data: 'x' } });
        restore();
        store.close();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error.code, 'PERSISTENCE_ERROR');
        assert.strictEqual(res.error.operation, 'store');
        assert.ok(res.error.message && res.error.message.includes('simulated upsert failure'));
      } finally { cleanupDb(dbPath); }
    });

    test('patchMetadata: SQLite write failure returns PERSISTENCE_ERROR/patchMetadata', () => {
      const dbPath = getDbPath('err-patch-sql');
      try {
        const store = newStore('err-patch-sql', { dbPath });
        const r1 = store.store({ content: { data: 'x' } });
        const restore = mockStatementThrow(store._stmts, 'upsertMemory', 'simulated patch failure');
        const res = store.patchMetadata(r1.memory.memoryId, { note: 'should fail' });
        restore();
        store.close();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error.code, 'PERSISTENCE_ERROR');
        assert.strictEqual(res.error.operation, 'patchMetadata');
      } finally { cleanupDb(dbPath); }
    });

    test('tombstone: SQLite write failure returns PERSISTENCE_ERROR/tombstone', () => {
      const dbPath = getDbPath('err-tomb-sql');
      try {
        const store = newStore('err-tomb-sql', { dbPath });
        const r1 = store.store({ content: { data: 'x' } });
        const restore = mockStatementThrow(store._stmts, 'upsertMemory', 'simulated tombstone failure');
        const res = store.tombstone(r1.memory.memoryId);
        restore();
        store.close();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error.code, 'PERSISTENCE_ERROR');
        assert.strictEqual(res.error.operation, 'tombstone');
      } finally { cleanupDb(dbPath); }
    });

    test('supersede: SQLite write failure returns PERSISTENCE_ERROR/supersede (no throw)', () => {
      const dbPath = getDbPath('err-supersede-sql');
      try {
        const store = newStore('err-supersede-sql', { dbPath });
        const r1 = store.store({ content: 'v1' });
        let callCount = 0;
        const originalRun = store._stmts.insertEvent.run;
        store._stmts.insertEvent.run = function() {
          callCount++;
          if (callCount >= 2) throw new Error('simulated supersede event failure');
          return originalRun.apply(this, arguments);
        };
        const res = store.supersede(r1.memory.memoryId, 'v2');
        store._stmts.insertEvent.run = originalRun;
        store.close();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error.code, 'PERSISTENCE_ERROR');
        assert.strictEqual(res.error.operation, 'supersede');
      } finally { cleanupDb(dbPath); }
    });

    test('linkMemories: SQLite write failure returns PERSISTENCE_ERROR/linkMemories (no DATABASE_ERROR)', () => {
      const dbPath = getDbPath('err-link-sql');
      try {
        const store = newStore('err-link-sql', { dbPath });
        const m1 = store.store({ content: 'a' }).memory;
        const m2 = store.store({ content: 'b' }).memory;
        const restore = mockStatementThrow(store._stmts, 'insertEvent', 'simulated link event failure');
        const res = store.linkMemories({
          fromMemoryId: m1.memoryId,
          toMemoryId: m2.memoryId,
          relation: 'supports',
        });
        restore();
        store.close();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error.code, 'PERSISTENCE_ERROR');
        assert.strictEqual(res.error.operation, 'linkMemories');
        assert.notStrictEqual(res.error.code, 'DATABASE_ERROR');
      } finally { cleanupDb(dbPath); }
    });
  });

  describe('SQLite transaction boundary & ROLLBACK', () => {
    test('linkMemories: mid-transaction failure rolls back insertLink + insertEvent', () => {
      const dbPath = getDbPath('rollback-link-detail');
      try {
        const store = newStore('rollback-link-detail', { dbPath });
        const m1 = store.store({ content: 'm1' }).memory;
        const m2 = store.store({ content: 'm2' }).memory;
        const restore = mockStatementThrow(store._stmts, 'insertEvent', 'mid-tx event failure');
        const res = store.linkMemories({
          fromMemoryId: m1.memoryId,
          toMemoryId: m2.memoryId,
          relation: 'supports',
        });
        restore();
        store.close();
        assert.strictEqual(res.ok, false);
        const store2 = newStore('rollback-link-detail', { dbPath });
        const linksRes = store2.queryLinks();
        assert.strictEqual(linksRes.total, 0);
        const eventsRes = store2.timeline();
        assert.strictEqual(eventsRes.total, 2);
        assert.ok(!eventsRes.events.some(e => e.eventType === 'LINKED'));
        store2.close();
      } finally { cleanupDb(dbPath); }
    });

    test('supersede: mid-transaction failure rolls back new memory, old memory status, link, both events', () => {
      const dbPath = getDbPath('rollback-supersede-detail');
      try {
        const store = newStore('rollback-supersede-detail', { dbPath });
        const r1 = store.store({ content: 'v1' });
        const mid1 = r1.memory.memoryId;
        let callCount = 0;
        const originalRun = store._stmts.insertEvent.run;
        store._stmts.insertEvent.run = function() {
          callCount++;
          if (callCount >= 2) throw new Error('simulated mid-tx supersede failure');
          return originalRun.apply(this, arguments);
        };
        const res = store.supersede(mid1, 'v2');
        store._stmts.insertEvent.run = originalRun;
        assert.strictEqual(res.ok, false);
        const oldMemCached = store.get(mid1).memory;
        assert.strictEqual(oldMemCached.status, 'active');
        store.close();
        const store2 = newStore('rollback-supersede-detail', { dbPath });
        const oldMemDB = store2.get(mid1).memory;
        assert.strictEqual(oldMemDB.status, 'active');
        const timeline = store2.timeline();
        assert.strictEqual(timeline.total, 1);
        assert.strictEqual(timeline.events[0].eventType, 'CREATED');
        const linksRes = store2.queryLinks();
        assert.strictEqual(linksRes.total, 0);
        store2.close();
      } finally { cleanupDb(dbPath); }
    });

    test('store: mid-transaction failure rolls back memory row + CREATED event', () => {
      const dbPath = getDbPath('rollback-store-detail');
      try {
        const store = newStore('rollback-store-detail', { dbPath });
        const restore = mockStatementThrow(store._stmts, 'insertEvent', 'mid-tx store event failure');
        const res = store.store({ content: { data: 'will-fail' } });
        restore();
        assert.strictEqual(res.ok, false);
        store.close();
        const store2 = newStore('rollback-store-detail', { dbPath });
        const listRes = store2.list();
        assert.strictEqual(listRes.total, 0);
        const timeline = store2.timeline();
        assert.strictEqual(timeline.total, 0);
        store2.close();
      } finally { cleanupDb(dbPath); }
    });
  });

  describe('In-memory transaction safety', () => {
    test('store: in-memory write always succeeds, no transaction boundary', () => {
      const store = new MemoryStore();
      const res = store.store({ content: { data: 'x' } });
      assert.strictEqual(res.ok, true);
      assert.ok(res.memory && res.memory.memoryId);
      const listRes = store.list();
      assert.strictEqual(listRes.total, 1);
      const timeline = store.timeline();
      assert.strictEqual(timeline.total, 1);
      assert.strictEqual(timeline.events[0].eventType, 'CREATED');
    });

    test('tombstone: in-memory state stays consistent without transaction wrapper', () => {
      const store = new MemoryStore();
      const r1 = store.store({ content: 'keep-me' }).memory;
      const res = store.tombstone(r1.memoryId);
      assert.strictEqual(res.ok, true);
      const after = store.get(r1.memoryId).memory;
      assert.strictEqual(after.status, 'deleted');
      const timeline = store.timeline();
      assert.strictEqual(timeline.total, 2);
      const types = timeline.events.map(e => e.eventType).sort();
      assert.deepStrictEqual(types, ['CREATED', 'TOMBSTONE']);
    });

    test('in-memory: _withTransaction restores snapshot on mid-transaction throw (no partial state)', () => {
      const store = new MemoryStore();
      const r1 = store.store({ content: 'pre-tx-1' }).memory;
      const r2 = store.store({ content: 'pre-tx-2' }).memory;
      store.linkMemories({ fromMemoryId: r1.memoryId, toMemoryId: r2.memoryId, relation: 'supports' });

      const memCountBefore = store.list().total;
      const eventCountBefore = store.timeline().total;
      const linkCountBefore = store.queryLinks().total;
      const preList = store.list().memories.map(m => m.memoryId).sort();

      assert.throws(() => {
        store._withTransaction(() => {
          store.store({ content: 'will-be-rolled-back' });
          store.linkMemories({ fromMemoryId: r1.memoryId, toMemoryId: r2.memoryId, relation: 'contradicts' });
          throw new Error('forced in-memory mid-transaction failure');
        });
      }, /forced in-memory mid-transaction failure/);

      assert.strictEqual(store.list().total, memCountBefore);
      assert.strictEqual(store.timeline().total, eventCountBefore);
      assert.strictEqual(store.queryLinks().total, linkCountBefore);
      const postList = store.list().memories.map(m => m.memoryId).sort();
      assert.deepStrictEqual(postList, preList);
    });
  });

  describe('Sequential state consistency (in-memory)', () => {
    test('store -> patchMetadata -> tombstone: 1 CREATED + 1 UPDATED + 1 TOMBSTONE, final state consistent', () => {
      const store = new MemoryStore();
      const r1 = store.store({ content: 'seq' }).memory;
      store.patchMetadata(r1.memoryId, { tag: 'v2' });
      store.tombstone(r1.memoryId);
      const timeline = store.timeline();
      assert.strictEqual(timeline.total, 3);
      const types = timeline.events.map(e => e.eventType).sort();
      assert.deepStrictEqual(types, ['CREATED', 'TOMBSTONE', 'UPDATED']);
      const after = store.get(r1.memoryId).memory;
      assert.strictEqual(after.status, 'deleted');
      assert.deepStrictEqual(after.metadata, { tag: 'v2' });
    });

    test('linkMemories: sequential distinct relations produce 2 links & 2 LINKED events', () => {
      const store = new MemoryStore();
      const m1 = store.store({ content: 'a' }).memory;
      const m2 = store.store({ content: 'b' }).memory;
      store.linkMemories({ fromMemoryId: m1.memoryId, toMemoryId: m2.memoryId, relation: 'supports' });
      store.linkMemories({ fromMemoryId: m1.memoryId, toMemoryId: m2.memoryId, relation: 'contradicts' });
      const links = store.queryLinks();
      assert.strictEqual(links.total, 2);
      const timeline = store.timeline();
      const linkEvents = timeline.events.filter(e => e.eventType === 'LINKED');
      assert.strictEqual(linkEvents.length, 2);
    });

    test('supersede: 2x sequential on same oldId keeps superseded links out of active queries', () => {
      const store = new MemoryStore();
      const r1 = store.store({ content: 'v1' }).memory;
      const res1 = store.supersede(r1.memoryId, 'v2a');
      const res2 = store.supersede(r1.memoryId, 'v2b');
      assert.strictEqual(res1.ok, true);
      assert.strictEqual(res2.ok, true);
      const activeLinks = store.queryLinks();
      assert.strictEqual(activeLinks.total, 0);
      const auditLinks = store.queryLinks({ includeDeleted: true });
      assert.strictEqual(auditLinks.total, 2);
      const timeline = store.timeline();
      const supEvents = timeline.events.filter(
        e => e.eventType === 'UPDATED' && e.details && e.details.action === 'supersede'
      );
      assert.strictEqual(supEvents.length, 2);
      const after = store.get(r1.memoryId).memory;
      assert.strictEqual(after.status, 'superseded');
    });
  });

  describe('In-memory + SQLite cross-check (regression parity)', () => {
    test('store + linkMemories in-memory and SQLite produce equal link counts & event types', () => {
      const mem = new MemoryStore();
      const m1m = mem.store({ content: 'a' }).memory;
      const m2m = mem.store({ content: 'b' }).memory;
      mem.linkMemories({ fromMemoryId: m1m.memoryId, toMemoryId: m2m.memoryId, relation: 'supports' });
      const memLinks = mem.queryLinks().total;
      const memEvents = mem.timeline().events.map(e => e.eventType).sort();

      const dbPath = getDbPath('parity-link');
      try {
        const sql = newStore('parity-link', { dbPath });
        const m1s = sql.store({ content: 'a' }).memory;
        const m2s = sql.store({ content: 'b' }).memory;
        sql.linkMemories({ fromMemoryId: m1s.memoryId, toMemoryId: m2s.memoryId, relation: 'supports' });
        const sqlLinks = sql.queryLinks().total;
        const sqlEvents = sql.timeline().events.map(e => e.eventType).sort();
        sql.close();
        assert.strictEqual(memLinks, sqlLinks);
        assert.deepStrictEqual(memEvents, sqlEvents);
      } finally { cleanupDb(dbPath); }
    });
  });
});
