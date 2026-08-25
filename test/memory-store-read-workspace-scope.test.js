'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');

// #1510: getLinks/getBacklinks/getEvents read the same data as their scoped
// siblings (findLinks/traverseLinks/eventsForMemory) and must apply the same
// workspace filter instead of relying on the unwritten invariant that ids
// never collide across workspaces.
describe('#1510 unscoped memory reads apply workspace scope', () => {
  function seed(store, workspaceId) {
    const from = store.store({ content: `from-${workspaceId}`, workspaceId }).memory;
    const to = store.store({ content: `to-${workspaceId}`, workspaceId }).memory;
    const linkRes = store.linkMemories({
      workspaceId,
      fromMemoryId: from.memoryId,
      toMemoryId: to.memoryId,
      relation: 'supports',
    });
    assert.strictEqual(linkRes.ok, true);
    return { from, to };
  }

  it('getLinks scopes to the requested workspace', () => {
    const store = new MemoryStore();
    const a = seed(store, 'tenant-a');
    seed(store, 'tenant-b');

    const scoped = store.getLinks(a.from.memoryId, { workspaceId: 'tenant-a' });
    assert.strictEqual(scoped.length, 1);
    assert.strictEqual(scoped[0].workspaceId, 'tenant-a');

    assert.deepStrictEqual(store.getLinks(a.from.memoryId, { workspaceId: 'tenant-b' }), []);
    assert.deepStrictEqual(store.getLinks(a.from.memoryId), []);
  });

  it('getBacklinks honours the workspaceId it accepts', () => {
    const store = new MemoryStore();
    const a = seed(store, 'tenant-a');

    const scoped = store.getBacklinks(a.to.memoryId, { workspaceId: 'tenant-a' });
    assert.strictEqual(scoped.length, 1);
    assert.strictEqual(scoped[0].toMemoryId, a.to.memoryId);

    assert.deepStrictEqual(store.getBacklinks(a.to.memoryId, { workspaceId: 'tenant-b' }), []);
  });

  it('getEvents scopes to the requested workspace', () => {
    const store = new MemoryStore();
    const a = seed(store, 'tenant-a');

    const scoped = store.getEvents(a.from.memoryId, { workspaceId: 'tenant-a' });
    assert.ok(scoped.length > 0);
    assert.ok(scoped.every((event) => event.workspaceId === 'tenant-a'));

    assert.deepStrictEqual(store.getEvents(a.from.memoryId, { workspaceId: 'tenant-b' }), []);
  });

  it('defaults to the default workspace, keeping single-tenant callers unchanged', () => {
    const store = new MemoryStore();
    const d = seed(store, 'default');

    assert.strictEqual(store.getLinks(d.from.memoryId).length, 1);
    assert.strictEqual(store.getBacklinks(d.to.memoryId).length, 1);
    assert.ok(store.getEvents(d.from.memoryId).length > 0);
  });
});
