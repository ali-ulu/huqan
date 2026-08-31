'use strict';

/**
 * Lifecycle smoke slice — tombstone/supersede downstream exclusion.
 *
 * Task-mapping note (#63): runTombstone/runSupersede are store-internal
 * delegates (lib/memory-tombstone.js, lib/memory-supersede.js) reached through
 * MemoryStore.tombstone()/supersede(). At main d67b2722 no CLI, REST or MCP
 * surface calls either method. One correction to the earlier mapping: the
 * standing surface audit (test/memory-store-surface-audit.test.js) classifies
 * tombstone() as test-only but records a production library caller for
 * supersede() through lib/error-prevention (published via
 * require('huqan').createErrorPrevention). So "no user surface" holds for
 * CLI/REST/MCP, not for the library surface.
 *
 * This file pins, programmatically at store level, which downstream read
 * surfaces exclude a tombstoned (status 'deleted') or superseded
 * (status 'superseded') record, and which deliberately keep it visible. The
 * asymmetries below (get/findById vs list, temporal/export keeping superseded
 * records, raw link reads without status filters) are the OBSERVED current
 * semantics at the pinned commit — they are documented here, not changed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const MemoryStore = require('../lib/memory-store');
const { getContentHash, makeProvenance } = require('../lib/memory-store-utils');

const WORKSPACE = 'ws-downstream';

function validProvenance(sourceRef) {
  const provenance = makeProvenance('tester', WORKSPACE, '1.0.0');
  provenance.sourceRef = sourceRef;
  return provenance;
}

function freshStoreWithTombstonedRecord() {
  const store = new MemoryStore();
  const kept = store.store({ content: 'kept', workspaceId: WORKSPACE }).memory;
  const record = store.store({
    content: 'doomed',
    workspaceId: WORKSPACE,
    provenance: validProvenance('downstream-src'),
  }).memory;
  const tombstone = store.tombstone(record.memoryId, { workspaceId: WORKSPACE });
  assert.equal(tombstone.ok, true);
  return { store, kept, record, tombstonedId: record.memoryId };
}

function freshStoreWithSupersededRecord() {
  const store = new MemoryStore();
  const old = store.store({ content: 'v1', workspaceId: WORKSPACE }).memory;
  const supersede = store.supersede(old.memoryId, 'v2', { workspaceId: WORKSPACE });
  assert.equal(supersede.ok, true);
  return { store, old, new: supersede.newMemory, supersededId: old.memoryId };
}

describe('Lifecycle smoke: tombstoned records are excluded from downstream reads', () => {
  it('active record reads exclude the tombstoned record; opt-in flags re-include it', () => {
    const { store, tombstonedId } = freshStoreWithTombstonedRecord();

    const list = store.list({ workspaceId: WORKSPACE });
    assert.equal(list.total, 1);
    assert.ok(!list.memories.some((m) => m.memoryId === tombstonedId));
    const listAll = store.list({ workspaceId: WORKSPACE, includeTombstoned: true });
    assert.equal(listAll.total, 2);

    const query = store.query({ workspaceId: WORKSPACE });
    assert.equal(query.total, 1);
    const queryAll = store.query({ workspaceId: WORKSPACE, includeDeleted: true });
    assert.equal(queryAll.total, 2);

    assert.equal(store.findById(tombstonedId, { workspaceId: WORKSPACE }).ok, false);
    assert.equal(
      store.findById(tombstonedId, { workspaceId: WORKSPACE, includeTombstoned: true }).ok,
      true
    );

    assert.equal(store.findByContentHash(getContentHash('doomed'), { workspaceId: WORKSPACE }).total, 0);
    assert.equal(
      store.findByContentHash(getContentHash('doomed'), { workspaceId: WORKSPACE, includeTombstoned: true }).total,
      1
    );
    assert.equal(store.findBySourceRef('downstream-src', { workspaceId: WORKSPACE }).total, 0);
    assert.equal(store.findByKind('memory-record', { workspaceId: WORKSPACE }).total, 1);
  });

  it('direct lookup and audit surfaces keep the tombstoned record and its events', () => {
    const { store, tombstonedId } = freshStoreWithTombstonedRecord();

    const direct = store.get(tombstonedId, { workspaceId: WORKSPACE });
    assert.equal(direct.ok, true);
    assert.equal(direct.memory.status, 'deleted');
    assert.ok(direct.memory.deletedAt);

    const byStatus = store.findByStatus('deleted', { workspaceId: WORKSPACE });
    assert.equal(byStatus.total, 1);
    assert.equal(byStatus.memories[0].memoryId, tombstonedId);

    const timeline = store.timeline({ workspaceId: WORKSPACE });
    const types = timeline.events.map((e) => e.eventType).sort();
    assert.deepEqual(types, ['CREATED', 'CREATED', 'TOMBSTONE']);
    const events = store.eventsForMemory(tombstonedId, { workspaceId: WORKSPACE });
    assert.equal(events.total, 2);
    const history = store.history(tombstonedId, { workspaceId: WORKSPACE });
    assert.equal(history.total, 2);
  });

  it('temporal reads and package export exclude it by default, include it on opt-in', () => {
    const { store, tombstonedId } = freshStoreWithTombstonedRecord();
    const since = '1970-01-01T00:00:00.000Z';

    assert.ok(!store.since(since, { workspaceId: WORKSPACE }).memories.some((m) => m.memoryId === tombstonedId));
    assert.ok(store.since(since, { workspaceId: WORKSPACE, includeTombstoned: true })
      .memories.some((m) => m.memoryId === tombstonedId));

    const exported = store.exportPackage({ workspaceId: WORKSPACE });
    assert.equal(exported.ok, true);
    assert.equal(exported.package.memories.length, 1);
    const exportedAll = store.exportPackage({ workspaceId: WORKSPACE, includeTombstoned: true });
    assert.equal(exportedAll.package.memories.length, 2);
  });

  it('links touching the tombstoned record leave active link reads and fail closed on new writes', () => {
    const store = new MemoryStore();
    const a = store.store({ content: 'A', workspaceId: WORKSPACE }).memory;
    const b = store.store({ content: 'B', workspaceId: WORKSPACE }).memory;
    const link = store.linkMemories({
      fromMemoryId: a.memoryId,
      toMemoryId: b.memoryId,
      relation: 'supports',
      workspaceId: WORKSPACE,
    });
    assert.equal(link.ok, true);
    assert.equal(store.tombstone(a.memoryId, { workspaceId: WORKSPACE }).ok, true);

    assert.equal(store.queryLinks({ workspaceId: WORKSPACE }).total, 0);
    assert.equal(store.queryLinks({ workspaceId: WORKSPACE, includeDeleted: true }).total, 1);
    assert.equal(store.linksForMemory(b.memoryId, { workspaceId: WORKSPACE }).links.length, 0);
    assert.equal(store.linksForMemory(b.memoryId, { workspaceId: WORKSPACE, includeDeleted: true }).links.length, 1);

    // Raw link reads keep no status filter at all (audit surface).
    assert.equal(store.findLinks(b.memoryId, { workspaceId: WORKSPACE }).links.length, 1);
    assert.equal(store.getLinks(a.memoryId, { workspaceId: WORKSPACE }).length, 1);
    assert.equal(store.getBacklinks(b.memoryId, { workspaceId: WORKSPACE }).length, 1);

    assert.equal(store.findLinkedMemories(b.memoryId, { workspaceId: WORKSPACE }).memories.length, 0);
    assert.equal(
      store.findLinkedMemories(b.memoryId, { workspaceId: WORKSPACE, includeTombstoned: true }).memories.length,
      1
    );

    const traversal = store.traverseLinks(b.memoryId, { workspaceId: WORKSPACE });
    assert.equal(traversal.ok, true);
    assert.equal(traversal.totalNodes, 1);
    const traversalAll = store.traverseLinks(b.memoryId, { workspaceId: WORKSPACE, includeTombstoned: true });
    assert.equal(traversalAll.totalNodes, 2);

    // A tombstoned record cannot gain new links: fail-closed INVALID_STATE.
    const blocked = store.linkMemories({
      fromMemoryId: b.memoryId,
      toMemoryId: a.memoryId,
      relation: 'references',
      workspaceId: WORKSPACE,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'INVALID_STATE');
  });
});

describe('Lifecycle smoke: superseded records in downstream reads (current semantics)', () => {
  it('active record reads exclude the superseded record; direct lookup keeps it', () => {
    const { store, old, supersededId } = freshStoreWithSupersededRecord();

    const list = store.list({ workspaceId: WORKSPACE });
    assert.equal(list.total, 1);
    assert.deepEqual(list.memories.map((m) => m.content), ['v2']);
    const listAll = store.list({ workspaceId: WORKSPACE, includeTombstoned: true });
    assert.equal(listAll.total, 2);
    assert.ok(listAll.memories.some((m) => m.memoryId === supersededId && m.status === 'superseded'));

    assert.equal(store.query({ workspaceId: WORKSPACE }).total, 1);

    // Observed asymmetry: findById filters 'deleted' only, so a superseded
    // record is still directly findable.
    const found = store.findById(supersededId, { workspaceId: WORKSPACE });
    assert.equal(found.ok, true);
    assert.equal(found.memory.status, 'superseded');
    assert.equal(store.get(supersededId, { workspaceId: WORKSPACE }).memory.memoryId, old.memoryId);

    assert.equal(store.findByStatus('superseded', { workspaceId: WORKSPACE }).total, 1);
    assert.equal(store.findByContentHash(getContentHash('v1'), { workspaceId: WORKSPACE }).total, 0);
    assert.equal(
      store.findByContentHash(getContentHash('v1'), { workspaceId: WORKSPACE, includeTombstoned: true }).total,
      1
    );
  });

  it('temporal reads and package export still include superseded records (observed asymmetry)', () => {
    const { store, supersededId } = freshStoreWithSupersededRecord();
    const since = '1970-01-01T00:00:00.000Z';

    // Unlike tombstones (filtered by status 'deleted'), superseded records are
    // not filtered by the temporal read: this pins the current behavior.
    const temporal = store.since(since, { workspaceId: WORKSPACE });
    assert.equal(temporal.total, 2);
    assert.ok(temporal.memories.some((m) => m.memoryId === supersededId));

    const exported = store.exportPackage({ workspaceId: WORKSPACE });
    assert.equal(exported.package.memories.length, 2);
  });

  it('the supersedes link leaves active link queries but stays on audit link reads', () => {
    const { store, old, new: replacement } = freshStoreWithSupersededRecord();

    assert.equal(store.queryLinks({ workspaceId: WORKSPACE }).total, 0);
    assert.equal(store.queryLinks({ workspaceId: WORKSPACE, includeDeleted: true }).total, 1);

    const linked = store.findLinkedMemories(old.memoryId, { workspaceId: WORKSPACE });
    assert.equal(linked.ok, true);
    assert.equal(linked.links.length, 1);
    assert.equal(linked.links[0].relation, 'supersedes');
    assert.deepEqual(linked.memories.map((m) => m.memoryId), [replacement.memoryId]);

    assert.equal(store.linksForMemory(old.memoryId, { workspaceId: WORKSPACE }).links.length, 0);
    assert.equal(store.linksForMemory(old.memoryId, { workspaceId: WORKSPACE, includeDeleted: true }).links.length, 1);

    // The replacement record is active and fully readable downstream.
    assert.equal(store.list({ workspaceId: WORKSPACE }).memories[0].memoryId, replacement.memoryId);
  });

  it('the link guard covers deleted endpoints only: superseded endpoints stay linkable', () => {
    const { store, supersededId } = freshStoreWithSupersededRecord();
    const other = store.store({ content: 'other', workspaceId: WORKSPACE }).memory;

    const toSuperseded = store.linkMemories({
      fromMemoryId: other.memoryId,
      toMemoryId: supersededId,
      relation: 'references',
      workspaceId: WORKSPACE,
    });
    assert.equal(toSuperseded.ok, true);

    const deleted = store.store({ content: 'gone', workspaceId: WORKSPACE }).memory;
    assert.equal(store.tombstone(deleted.memoryId, { workspaceId: WORKSPACE }).ok, true);
    const toDeleted = store.linkMemories({
      fromMemoryId: other.memoryId,
      toMemoryId: deleted.memoryId,
      relation: 'references',
      workspaceId: WORKSPACE,
    });
    assert.equal(toDeleted.ok, false);
    assert.equal(toDeleted.error.code, 'INVALID_STATE');
  });
});
