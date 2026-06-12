'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function createKernel() {
  return new Kernel({ noLoad: true, loadPlugins: false, useSQLite: false });
}

describe('kernel.memory API', () => {
  it('exposes the required API surface', () => {
    const kernel = createKernel();
    assert.ok(kernel.memory);
    assert.strictEqual(typeof kernel.memory.store, 'function');
    assert.strictEqual(typeof kernel.memory.get, 'function');
    assert.strictEqual(typeof kernel.memory.list, 'function');
    assert.strictEqual(typeof kernel.memory.search, 'function');
    assert.strictEqual(typeof kernel.memory.link, 'function');
    assert.strictEqual(typeof kernel.memory.tombstone, 'function');
    assert.strictEqual(typeof kernel.memory.supersede, 'function');
    assert.strictEqual(typeof kernel.memory.contradict, 'function');
  });

  it('stores, gets, lists and searches memories inside a workspace', () => {
    const kernel = createKernel();
    const stored = kernel.memory.store({
      content: { claim: 'Memory Core is deterministic' },
      workspaceId: 'ws-m2',
      metadata: { tag: 'core' },
    });
    assert.strictEqual(stored.ok, true);
    assert.strictEqual(stored.created, true);

    const fetched = kernel.memory.get(stored.memory.memoryId, { workspaceId: 'ws-m2' });
    assert.strictEqual(fetched.ok, true);
    assert.deepStrictEqual(fetched.memory.content, { claim: 'Memory Core is deterministic' });

    const listed = kernel.memory.list({ workspaceId: 'ws-m2' });
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.total, 1);

    const searched = kernel.memory.search('deterministic', { workspaceId: 'ws-m2' });
    assert.strictEqual(searched.ok, true);
    assert.strictEqual(searched.total, 1);
    assert.strictEqual(searched.memories[0].memoryId, stored.memory.memoryId);
  });

  it('is idempotent for identical content in the same workspace', () => {
    const kernel = createKernel();
    const first = kernel.memory.store({
      content: { text: 'same fact' },
      workspaceId: 'ws-idem',
    });
    const second = kernel.memory.store({
      content: { text: 'same fact' },
      workspaceId: 'ws-idem',
    });

    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.created, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.created, false);
    assert.strictEqual(first.memory.memoryId, second.memory.memoryId);

    const listed = kernel.memory.list({ workspaceId: 'ws-idem' });
    assert.strictEqual(listed.total, 1);
  });

  it('keeps idempotency scoped to workspace', () => {
    const kernel = createKernel();
    const workspaceA = kernel.memory.store({ content: { text: 'shared fact' }, workspaceId: 'ws-a' });
    const workspaceB = kernel.memory.store({ content: { text: 'shared fact' }, workspaceId: 'ws-b' });

    assert.strictEqual(workspaceA.ok, true);
    assert.strictEqual(workspaceB.ok, true);
    assert.notStrictEqual(workspaceA.memory.memoryId, workspaceB.memory.memoryId);

    const listA = kernel.memory.list({ workspaceId: 'ws-a' });
    const listB = kernel.memory.list({ workspaceId: 'ws-b' });
    assert.strictEqual(listA.total, 1);
    assert.strictEqual(listB.total, 1);
    assert.strictEqual(listA.memories[0].memoryId, workspaceA.memory.memoryId);
    assert.strictEqual(listB.memories[0].memoryId, workspaceB.memory.memoryId);
  });

  it('returns safe copies that do not mutate store state', () => {
    const kernel = createKernel();
    const stored = kernel.memory.store({
      content: { deep: { value: 'locked' } },
      workspaceId: 'ws-copy',
    });
    const memoryId = stored.memory.memoryId;

    stored.memory.content.deep.value = 'changed';
    stored.memory.status = 'deleted';
    stored.memory.workspaceId = 'other';

    const fetched = kernel.memory.get(memoryId, { workspaceId: 'ws-copy' });
    assert.strictEqual(fetched.memory.content.deep.value, 'locked');
    assert.strictEqual(fetched.memory.status, 'active');
    assert.strictEqual(fetched.memory.workspaceId, 'ws-copy');

    const listResult = kernel.memory.list({ workspaceId: 'ws-copy' });
    listResult.memories[0].content.deep.value = 'list-mutated';
    listResult.memories[0].status = 'deleted';

    const fetchedAfterListMutation = kernel.memory.get(memoryId, { workspaceId: 'ws-copy' });
    assert.strictEqual(fetchedAfterListMutation.memory.content.deep.value, 'locked');
    assert.strictEqual(fetchedAfterListMutation.memory.status, 'active');

    const searchResult = kernel.memory.search('locked', { workspaceId: 'ws-copy' });
    searchResult.memories[0].content.deep.value = 'search-mutated';
    searchResult.memories[0].status = 'deleted';

    const fetchedAfterSearchMutation = kernel.memory.get(memoryId, { workspaceId: 'ws-copy' });
    assert.strictEqual(fetchedAfterSearchMutation.memory.content.deep.value, 'locked');
    assert.strictEqual(fetchedAfterSearchMutation.memory.status, 'active');
  });

  it('links memories and records contradiction links', () => {
    const kernel = createKernel();
    const left = kernel.memory.store({ content: 'left memory', workspaceId: 'ws-link' }).memory;
    const right = kernel.memory.store({ content: 'right memory', workspaceId: 'ws-link' }).memory;

    const linked = kernel.memory.link({
      fromMemoryId: left.memoryId,
      toMemoryId: right.memoryId,
      relation: 'supports',
      workspaceId: 'ws-link',
    });
    assert.strictEqual(linked.ok, true);
    assert.strictEqual(linked.link.relation, 'supports');

    const contradicted = kernel.memory.contradict(left.memoryId, right.memoryId, {
      workspaceId: 'ws-link',
    });
    assert.strictEqual(contradicted.ok, true);
    assert.strictEqual(contradicted.link.relation, 'contradicts');
  });

  it('tombstones and supersedes memories safely', () => {
    const kernel = createKernel();
    const base = kernel.memory.store({ content: 'v1 fact', workspaceId: 'ws-mutate' }).memory;

    const superseded = kernel.memory.supersede(base.memoryId, 'v2 fact', { workspaceId: 'ws-mutate' });
    assert.strictEqual(superseded.ok, true);
    assert.strictEqual(superseded.oldMemory.status, 'superseded');
    assert.strictEqual(superseded.newMemory.supersedesMemoryId, base.memoryId);
    assert.strictEqual(superseded.link.relation, 'supersedes');

    const tombstoned = kernel.memory.tombstone(superseded.newMemory.memoryId, { workspaceId: 'ws-mutate' });
    assert.strictEqual(tombstoned.ok, true);
    assert.strictEqual(tombstoned.memory.status, 'deleted');

    const listed = kernel.memory.list({ workspaceId: 'ws-mutate' });
    assert.strictEqual(listed.total, 1);
    assert.strictEqual(listed.memories[0].memoryId, base.memoryId);
  });
});
