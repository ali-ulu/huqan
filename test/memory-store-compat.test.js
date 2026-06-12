'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');
const MemoryStore = require('../lib/memory-store');
const { getContentHash } = require('../lib/memory-store-utils');

function installMockDate(times) {
  const OriginalDate = Date;
  let index = 0;
  global.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length > 0) {
        return new OriginalDate(...args);
      }
      return new OriginalDate(times[index]);
    }
    static now() {
      return new OriginalDate(times[index]).getTime();
    }
  };
  return {
    setIndex(nextIndex) {
      index = nextIndex;
    },
    restore() {
      global.Date = OriginalDate;
    },
  };
}

describe('main memory compatibility aliases', () => {
  it('accepts legacy kernel memoryStore options', () => {
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      memoryStoreUseSQLite: false,
    });

    assert.ok(kernel.memory);
    assert.strictEqual(typeof kernel.memory.findById, 'function');
    assert.strictEqual(typeof kernel.memory.link, 'function');
    assert.strictEqual(typeof kernel.memory.since, 'function');
    assert.strictEqual(typeof kernel.memory.save, 'function');
    assert.strictEqual(typeof kernel.memory.load, 'function');
  });

  it('preserves old Memory Core alias methods on the main MemoryStore', () => {
    const store = new MemoryStore({ useSQLite: false });

    const first = store.store({ content: { label: 'alpha' }, workspaceId: 'ws-compat' }).memory;
    const second = store.store({ content: { label: 'beta' }, workspaceId: 'ws-compat' }).memory;
    const third = store.store({ content: { label: 'gamma' }, workspaceId: 'ws-compat' }).memory;

    assert.strictEqual(store.findById(first.memoryId, { workspaceId: 'ws-compat' }).ok, true);

    const hashRes = store.findByContentHash(getContentHash(first.content), { workspaceId: 'ws-compat' });
    assert.strictEqual(hashRes.ok, true);
    assert.strictEqual(hashRes.total, 1);
    assert.strictEqual(hashRes.memories[0].memoryId, first.memoryId);

    const sourceRes = store.findBySourceRef('axiom-memory-core', { workspaceId: 'ws-compat' });
    assert.strictEqual(sourceRes.ok, true);
    assert.strictEqual(sourceRes.total, 3);

    const kindRes = store.findByKind('memory-record', { workspaceId: 'ws-compat' });
    assert.strictEqual(kindRes.ok, true);
    assert.strictEqual(kindRes.total, 3);

    const statusRes = store.findByStatus('active', { workspaceId: 'ws-compat' });
    assert.strictEqual(statusRes.ok, true);
    assert.strictEqual(statusRes.total, 3);

    assert.strictEqual(store.save().ok, true);
    assert.strictEqual(store.load().ok, true);

    const supports = store.link({
      fromMemoryId: first.memoryId,
      toMemoryId: second.memoryId,
      relation: 'supports',
      workspaceId: 'ws-compat',
    });
    assert.strictEqual(supports.ok, true);
    assert.strictEqual(supports.link.relation, 'supports');

    const contradicts = store.contradict(first.memoryId, third.memoryId, { workspaceId: 'ws-compat' });
    assert.strictEqual(contradicts.ok, true);
    assert.strictEqual(contradicts.link.relation, 'contradicts');

    const findLinksRes = store.findLinks(first.memoryId, { workspaceId: 'ws-compat', direction: 'outgoing' });
    assert.strictEqual(findLinksRes.ok, true);
    assert.strictEqual(findLinksRes.total, 2);

    const linkedRes = store.findLinkedMemories(first.memoryId, { workspaceId: 'ws-compat' });
    assert.strictEqual(linkedRes.ok, true);
    assert.strictEqual(linkedRes.total, 2);
    assert.deepStrictEqual(linkedRes.memories.map((record) => record.memoryId).sort(), [second.memoryId, third.memoryId].sort());

    const historyRes = store.history(first.memoryId, { workspaceId: 'ws-compat' });
    assert.strictEqual(historyRes.ok, true);
    assert.ok(historyRes.events.some((event) => event.eventType === 'CREATED'));
    assert.ok(historyRes.events.some((event) => event.eventType === 'LINKED'));

    const backlinks = store.getBacklinks(second.memoryId, { workspaceId: 'ws-compat' });
    assert.strictEqual(Array.isArray(backlinks), true);
    assert.strictEqual(backlinks.length, 1);
    assert.strictEqual(backlinks[0].toMemoryId, second.memoryId);

    const traversal = store.traverseLinks(first.memoryId, { workspaceId: 'ws-compat', maxDepth: 1 });
    assert.strictEqual(traversal.ok, true);
    assert.ok(traversal.nodes.length >= 2);
    assert.strictEqual(traversal.links.length, 2);
  });

  it('keeps link ordering deterministic and supports temporal helpers', () => {
    const clock = installMockDate([
      '2026-06-03T12:00:00.000Z',
      '2026-06-03T12:00:00.000Z',
      '2026-06-03T12:00:00.000Z',
      '2026-06-03T12:00:05.000Z',
      '2026-06-03T12:00:10.000Z',
    ]);

    try {
      const store = new MemoryStore({ useSQLite: false });

      clock.setIndex(0);
      const root = store.store({ content: 'root', workspaceId: 'ws-order' }).memory;
      clock.setIndex(1);
      const targetB = store.store({ content: 'beta', workspaceId: 'ws-order' }).memory;
      clock.setIndex(2);
      const targetC = store.store({ content: 'charlie', workspaceId: 'ws-order' }).memory;

      clock.setIndex(3);
      store.link({
        fromMemoryId: root.memoryId,
        toMemoryId: targetC.memoryId,
        relation: 'supports',
        workspaceId: 'ws-order',
      });
      clock.setIndex(4);
      store.link({
        fromMemoryId: root.memoryId,
        toMemoryId: targetB.memoryId,
        relation: 'supports',
        workspaceId: 'ws-order',
      });

      const links = store.queryLinks({ workspaceId: 'ws-order', fromMemoryId: root.memoryId });
      assert.strictEqual(links.ok, true);
      assert.deepStrictEqual(
        links.links.map((link) => link.toMemoryId),
        [targetB.memoryId, targetC.memoryId].sort(),
      );

      const both = store.linksForMemory(root.memoryId, { workspaceId: 'ws-order', direction: 'both' });
      assert.strictEqual(both.ok, true);
      assert.deepStrictEqual(
        both.links.map((link) => link.toMemoryId),
        [targetB.memoryId, targetC.memoryId].sort(),
      );

      clock.setIndex(0);
      const t0 = store.store({ content: 't0', workspaceId: 'ws-time' }).memory;
      clock.setIndex(1);
      const t1 = store.store({ content: 't1', workspaceId: 'ws-time' }).memory;
      clock.setIndex(2);
      const t2 = store.store({ content: 't2', workspaceId: 'ws-time' }).memory;

      const sinceRes = store.since('2026-06-03T12:00:00.000Z', { workspaceId: 'ws-time' });
      assert.strictEqual(sinceRes.ok, true);
      assert.deepStrictEqual(
        sinceRes.memories.map((record) => record.memoryId),
        [t0.memoryId, t1.memoryId, t2.memoryId].sort(),
      );

      const beforeRes = store.before('2026-06-03T12:00:10.000Z', { workspaceId: 'ws-time' });
      assert.strictEqual(beforeRes.ok, true);
      assert.deepStrictEqual(
        beforeRes.memories.map((record) => record.memoryId),
        [t0.memoryId, t1.memoryId, t2.memoryId].sort(),
      );

      const betweenRes = store.between('2026-06-03T12:00:00.000Z', '2026-06-03T12:00:05.000Z', { workspaceId: 'ws-time' });
      assert.strictEqual(betweenRes.ok, true);
      assert.deepStrictEqual(
        betweenRes.memories.map((record) => record.memoryId),
        [t0.memoryId, t1.memoryId, t2.memoryId].sort(),
      );
    } finally {
      clock.restore();
    }
  });
});
