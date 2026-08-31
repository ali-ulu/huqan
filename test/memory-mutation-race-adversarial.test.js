'use strict';

/**
 * Lifecycle smoke slice — adversarial concurrency on MemoryStore mutations.
 *
 * Task-mapping note (#92): MemoryStore mutations are synchronous, and
 * better-sqlite3 is a synchronous driver, so Promise.all-style "parallel"
 * mutation batches execute each mutation atomically in schedule order on the
 * JS main thread — there is no interleaving inside a mutation and no parallel
 * write path to guard. These tests pin that CURRENT consistency contract
 * without trying to improve it:
 *
 *   1. every racing mutation is applied whole and logged (no torn state);
 *   2. status transitions are unguarded (no transition validation), so the
 *      last mutation in the schedule wins the final status — re-tombstoning
 *      or superseding a deleted record both succeed today;
 *   3. the one fail-closed guard that does exist (linkMemories refuses
 *      deleted endpoints with INVALID_STATE) holds under adversarial
 *      scheduling in both orders.
 *
 * Event-log ORDER is deliberately never asserted: same-millisecond events are
 * sorted by random event ids (sortByEventSignature), so order assertions
 * would be flaky under concurrency=4.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const MemoryStore = require('../lib/memory-store');

const WORKSPACE = 'ws-race';

function countByType(events, type) {
  return events.filter((event) => event.eventType === type).length;
}

describe('Lifecycle smoke: adversarial concurrent mutation schedules', () => {
  it('Promise.all racing tombstone/supersede/patchMetadata applies every mutation atomically', async () => {
    const store = new MemoryStore();
    const record = store.store({ content: 'contended', workspaceId: WORKSPACE }).memory;

    const outcomes = await Promise.all([
      Promise.resolve().then(() => store.tombstone(record.memoryId, { workspaceId: WORKSPACE, actor: 'op-tombstone' })),
      Promise.resolve().then(() => store.supersede(record.memoryId, 'contended-v2', { workspaceId: WORKSPACE, actor: 'op-supersede' })),
      Promise.resolve().then(() => store.patchMetadata(record.memoryId, { tag: 'raced' }, { workspaceId: WORKSPACE, actor: 'op-patch' })),
    ]);

    // Current contract: no status-transition guards, so every scheduled
    // mutation succeeds and lands in the log; the supersede (last status
    // writer in schedule order) wins the final status.
    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true, true]);

    const after = store.get(record.memoryId, { workspaceId: WORKSPACE });
    assert.equal(after.ok, true);
    assert.equal(after.memory.status, 'superseded');
    assert.deepEqual(after.memory.metadata, { tag: 'raced' });

    const timeline = store.timeline({ workspaceId: WORKSPACE });
    assert.equal(timeline.total, 5);
    assert.equal(countByType(timeline.events, 'CREATED'), 2);
    assert.equal(countByType(timeline.events, 'TOMBSTONE'), 1);
    assert.equal(countByType(timeline.events, 'UPDATED'), 2);

    // The superseding record exists exactly once and is active.
    const active = store.list({ workspaceId: WORKSPACE });
    assert.equal(active.total, 1);
    assert.equal(active.memories[0].content, 'contended-v2');
  });

  it('reversed schedule: supersede then tombstone leaves tombstone as the winning status', async () => {
    const store = new MemoryStore();
    const record = store.store({ content: 'contended-2', workspaceId: WORKSPACE }).memory;

    const outcomes = await Promise.all([
      Promise.resolve().then(() => store.supersede(record.memoryId, 'v2', { workspaceId: WORKSPACE, actor: 'op-supersede' })),
      Promise.resolve().then(() => store.tombstone(record.memoryId, { workspaceId: WORKSPACE, actor: 'op-tombstone' })),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true]);
    const supersedingId = outcomes[0].newMemory.memoryId;

    const after = store.get(record.memoryId, { workspaceId: WORKSPACE });
    assert.equal(after.memory.status, 'deleted');

    const timeline = store.timeline({ workspaceId: WORKSPACE });
    assert.equal(timeline.total, 4);
    assert.equal(countByType(timeline.events, 'CREATED'), 2);
    assert.equal(countByType(timeline.events, 'UPDATED'), 1);
    assert.equal(countByType(timeline.events, 'TOMBSTONE'), 1);

    // Observed semantics: tombstoning the old record does not cascade to the
    // record that superseded it.
    assert.equal(store.get(supersedingId, { workspaceId: WORKSPACE }).memory.status, 'active');
    const activeList = store.list({ workspaceId: WORKSPACE });
    assert.equal(activeList.total, 1);
    assert.equal(activeList.memories[0].memoryId, supersedingId);
  });

  it('racing double tombstone records every attempt and converges to one deleted record', async () => {
    const store = new MemoryStore();
    const record = store.store({ content: 'double-tombstone', workspaceId: WORKSPACE }).memory;

    const outcomes = await Promise.all([
      Promise.resolve().then(() => store.tombstone(record.memoryId, { workspaceId: WORKSPACE, actor: 'op-a' })),
      Promise.resolve().then(() => store.tombstone(record.memoryId, { workspaceId: WORKSPACE, actor: 'op-b' })),
    ]);

    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true]);
    const timeline = store.timeline({ workspaceId: WORKSPACE });
    assert.equal(countByType(timeline.events, 'TOMBSTONE'), 2, 'each tombstone attempt is journaled');
    assert.equal(store.findByStatus('deleted', { workspaceId: WORKSPACE }).total, 1);
    assert.equal(store.list({ workspaceId: WORKSPACE }).total, 0);
  });

  it('the deleted-endpoint link guard holds in both racing orders', async () => {
    // Order 1: tombstone first — the link attempt must fail closed.
    const storeA = new MemoryStore();
    const a = storeA.store({ content: 'A', workspaceId: WORKSPACE }).memory;
    const b = storeA.store({ content: 'B', workspaceId: WORKSPACE }).memory;
    const [tombstoneFirst, linkFirstBlocked] = await Promise.all([
      Promise.resolve().then(() => storeA.tombstone(a.memoryId, { workspaceId: WORKSPACE })),
      Promise.resolve().then(() => storeA.linkMemories({
        fromMemoryId: b.memoryId,
        toMemoryId: a.memoryId,
        relation: 'supports',
        workspaceId: WORKSPACE,
      })),
    ]);
    assert.equal(tombstoneFirst.ok, true);
    assert.equal(linkFirstBlocked.ok, false);
    assert.equal(linkFirstBlocked.error.code, 'INVALID_STATE');
    assert.equal(storeA.queryLinks({ workspaceId: WORKSPACE }).total, 0);

    // Order 2: link first — the link succeeds, then the tombstone excludes it
    // from active link reads while the raw audit read keeps it.
    const storeB = new MemoryStore();
    const c = storeB.store({ content: 'C', workspaceId: WORKSPACE }).memory;
    const d = storeB.store({ content: 'D', workspaceId: WORKSPACE }).memory;
    const [linkSecond, tombstoneSecond] = await Promise.all([
      Promise.resolve().then(() => storeB.linkMemories({
        fromMemoryId: c.memoryId,
        toMemoryId: d.memoryId,
        relation: 'supports',
        workspaceId: WORKSPACE,
      })),
      Promise.resolve().then(() => storeB.tombstone(d.memoryId, { workspaceId: WORKSPACE })),
    ]);
    assert.equal(linkSecond.ok, true);
    assert.equal(tombstoneSecond.ok, true);
    assert.equal(storeB.queryLinks({ workspaceId: WORKSPACE }).total, 0);
    assert.equal(storeB.queryLinks({ workspaceId: WORKSPACE, includeDeleted: true }).total, 1);
    assert.equal(storeB.findLinks(c.memoryId, { workspaceId: WORKSPACE }).links.length, 1);
  });

  it('high-contention batch over many records keeps list and status invariants', async () => {
    const store = new MemoryStore();
    const records = [];
    for (let i = 0; i < 10; i++) {
      records.push(store.store({ content: `record-${i}`, workspaceId: WORKSPACE }).memory);
    }

    const outcomes = await Promise.all(records.map((record) =>
      Promise.resolve().then(() => store.tombstone(record.memoryId, { workspaceId: WORKSPACE, actor: 'batch' }))
    ));

    assert.equal(outcomes.length, 10);
    assert.ok(outcomes.every((outcome) => outcome.ok === true));
    assert.equal(store.list({ workspaceId: WORKSPACE }).total, 0);
    assert.equal(store.findByStatus('deleted', { workspaceId: WORKSPACE }).total, 10);
    const timeline = store.timeline({ workspaceId: WORKSPACE });
    assert.equal(timeline.total, 20);
    assert.equal(countByType(timeline.events, 'CREATED'), 10);
    assert.equal(countByType(timeline.events, 'TOMBSTONE'), 10);
  });
});
