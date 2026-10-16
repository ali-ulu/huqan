'use strict';

// #2120 moved the read and write method groups out of lib/memory-store.js
// into lib/memory-store-{read,write}-methods.js and installs them on
// MemoryStore.prototype. These tests pin what the move must not change: the
// prototype surface, the descriptor shape of a class member, and the refusal
// to silently replace a method the entry already defines.

const assert = require('node:assert/strict');
const test = require('node:test');

const MemoryStore = require('../lib/memory-store');
const { installMemoryStoreMethods } = require('../lib/memory-store-method-install');

const GROUPS = Object.freeze({
  'memory-store-read-methods': [
    '_linkReadContext', '_eventReadContext', '_recordReadContext', '_temporalReadContext',
    'list', 'get', 'getEvents', 'getLinks', '_queryTemporalMemories',
    'findById', 'findByContentHash', 'findBySourceRef', 'findByKind', 'findByStatus',
    'findLinks', 'findLinkedMemories', 'history',
    'getBacklinks', 'traverseLinks', 'since', 'before', 'between',
    'query', 'search', 'queryLinks', 'linksForMemory',
    'eventsForMemory', 'timeline', 'memoriesBetween', 'exportPackage',
  ],
  'memory-store-write-methods': [
    '_linkWriteStoreApi', 'store', '_storeStoreApi',
    'patchMetadata', '_patchMetadataStoreApi',
    'tombstone', '_tombstoneStoreApi',
    'supersede', '_supersedeStoreApi',
    'link', 'contradict', 'linkMemories',
    'importPackage', '_importPackageStoreApi',
  ],
});

test('every moved method is installed with the descriptor of a class member', () => {
  for (const [group, names] of Object.entries(GROUPS)) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(MemoryStore.prototype, name);
      assert.ok(descriptor, `${group}: MemoryStore.prototype.${name} is missing`);
      assert.equal(typeof descriptor.value, 'function', `${name} must stay a method`);
      assert.equal(descriptor.enumerable, false, `${name} must stay non-enumerable`);
      assert.equal(descriptor.writable, true, `${name} must stay writable`);
      assert.equal(descriptor.configurable, true, `${name} must stay configurable`);
    }
  }
  const store = new MemoryStore({ useSQLite: false });
  try {
    assert.deepEqual(Object.keys(store).filter((key) => Object.values(GROUPS).flat().includes(key)), []);
  } finally {
    store.close();
  }
});

test('installMemoryStoreMethods refuses to replace a method the store already has', () => {
  class Target { existing() { return 'kept'; } }
  class Holder { existing() { return 'replaced'; } }
  assert.throws(() => installMemoryStoreMethods(Target, Holder), /MemoryStore\.prototype\.existing is already defined/);
  assert.equal(new Target().existing(), 'kept');
});

test('installed read/write facades delegate through the store they are called on', () => {
  const store = new MemoryStore({ useSQLite: false });
  try {
    const stored = store.store({ content: 'method-group move' });
    assert.equal(stored.ok, true);
    const id = stored.memory.memoryId;
    assert.equal(store.get(id).ok, true);
    assert.equal(store.list().total, 1);
    // search() is classified unreached in the surface audit: no caller,
    // not even a test, may reach it, so only query() is exercised here.
    assert.equal(store.query({}).total, 1);
    assert.equal(store.since(new Date(0).toISOString()).ok, true);
    assert.equal(store.timeline({}).ok, true);

    const linked = store.store({ content: 'second' });
    const linkRes = store.link({ fromMemoryId: id, toMemoryId: linked.memory.memoryId, relation: 'related_to' });
    assert.equal(linkRes.ok, true);
    assert.equal(store.queryLinks({}).total, 1);
    const contra = store.contradict(id, linked.memory.memoryId);
    assert.equal(contra.ok, true);

    const exported = store.exportPackage({ workspaceId: 'default' });
    assert.equal(exported.ok, true);
    const tomb = store.tombstone(linked.memory.memoryId);
    assert.equal(tomb.ok, true);
    assert.equal(store.get(id).ok, true);
  } finally {
    store.close();
  }
});
