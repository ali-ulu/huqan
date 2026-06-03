'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');

// Helper: create a fresh store per test
function createStore(opts) {
  return new MemoryStore(opts);
}

describe('memory-store', () => {

  // ── store ────────────────────────────────────────────────
  it('store creates a valid memory with deterministic id', () => {
    const store = createStore();
    const result = store.store({ content: { claim: 'AXIOM judges' } });
    assert.strictEqual(result.ok, true);
    assert.ok(result.memory);
    assert.strictEqual(typeof result.memory.memoryId, 'string');
    assert.strictEqual(result.memory.memoryId.length, 16);
    assert.strictEqual(result.memory.status, 'active');
    assert.strictEqual(result.memory.workspaceId, 'default');
    assert.deepStrictEqual(result.memory.content, { claim: 'AXIOM judges' });
    assert.ok(result.event);
    assert.strictEqual(result.event.eventType, 'CREATED');
  });

  it('store rejects missing content', () => {
    const store = createStore();
    const result = store.store({});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'INVALID_INPUT');
  });

  it('store rejects non-object input', () => {
    const store = createStore();
    const result = store.store(null);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'INVALID_INPUT');
  });

  it('store accepts string content', () => {
    const store = createStore();
    const result = store.store({ content: 'a plain string memory' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.memory.content, 'a plain string memory');
  });

  // ── list ─────────────────────────────────────────────────
  it('list returns memories in deterministic order', () => {
    const store = createStore();
    store.store({ content: 'alpha' });
    store.store({ content: 'beta' });
    store.store({ content: 'gamma' });

    const result = store.list();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.total, 3);
    // Order by createdAt ascending
    const contents = result.memories.map(m => m.content);
    assert.strictEqual(contents[0], 'alpha');
    assert.strictEqual(contents[2], 'gamma');
  });

  it('list does not return tombstoned memories by default', () => {
    const store = createStore();
    const r1 = store.store({ content: 'visible' });
    const r2 = store.store({ content: 'hidden' });
    store.tombstone(r2.memory.memoryId);

    const result = store.list();
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.memories[0].content, 'visible');
  });

  it('list can include tombstoned memories if requested', () => {
    const store = createStore();
    const r1 = store.store({ content: 'visible' });
    const r2 = store.store({ content: 'hidden' });
    store.tombstone(r2.memory.memoryId);

    const result = store.list({ includeTombstoned: true });
    assert.strictEqual(result.total, 2);
  });

  it('list supports limit and offset', () => {
    const store = createStore();
    for (let i = 0; i < 10; i++) {
      store.store({ content: `item-${i}` });
    }
    const page = store.list({ limit: 3, offset: 2 });
    assert.strictEqual(page.ok, true);
    assert.strictEqual(page.memories.length, 3);
    assert.strictEqual(page.total, 10);
  });

  // ── get ──────────────────────────────────────────────────
  it('get returns memory by id', () => {
    const store = createStore();
    const r = store.store({ content: { fact: 'V1 is decision speed' } });
    const result = store.get(r.memory.memoryId);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.memory.content, { fact: 'V1 is decision speed' });
  });

  it('get returns NOT_FOUND for unknown id', () => {
    const store = createStore();
    const result = store.get('nonexistent');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'NOT_FOUND');
  });

  it('get rejects missing memoryId', () => {
    const store = createStore();
    const result = store.get('');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'INVALID_INPUT');
  });

  // ── patchMetadata ────────────────────────────────────────
  it('patchMetadata updates mutable metadata only', () => {
    const store = createStore();
    const r = store.store({ content: 'test', metadata: { tag: 'old' } });
    const result = store.patchMetadata(r.memory.memoryId, { tag: 'new', extra: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.memory.metadata.tag, 'new');
    assert.strictEqual(result.memory.metadata.extra, true);
    assert.ok(result.memory.updatedAt);
    assert.strictEqual(result.event.eventType, 'UPDATED');
  });

  it('patchMetadata cannot overwrite content', () => {
    const store = createStore();
    const r = store.store({ content: 'immutable fact' });
    const result = store.patchMetadata(r.memory.memoryId, { content: 'hacked' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'IMMUTABLE_CONTENT');
    // Verify content is unchanged
    const check = store.get(r.memory.memoryId);
    assert.strictEqual(check.memory.content, 'immutable fact');
  });

  it('patchMetadata returns NOT_FOUND for unknown id', () => {
    const store = createStore();
    const result = store.patchMetadata('nonexistent', { tag: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'NOT_FOUND');
  });

  // ── tombstone ────────────────────────────────────────────
  it('tombstone marks memory as deleted with timestamp', () => {
    const store = createStore();
    const r = store.store({ content: 'to be tombstoned' });
    const result = store.tombstone(r.memory.memoryId);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.memory.status, 'deleted');
    assert.ok(result.memory.deletedAt);
    assert.strictEqual(result.event.eventType, 'TOMBSTONE');
    // Memory still exists in store
    const check = store.get(r.memory.memoryId);
    assert.strictEqual(check.ok, true);
    assert.strictEqual(check.memory.status, 'deleted');
  });

  it('tombstone hides memory from default list', () => {
    const store = createStore();
    const r = store.store({ content: 'will hide' });
    store.tombstone(r.memory.memoryId);
    const list = store.list();
    assert.strictEqual(list.total, 0);
  });

  it('tombstone returns NOT_FOUND for unknown id', () => {
    const store = createStore();
    const result = store.tombstone('nonexistent');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'NOT_FOUND');
  });

  // ── supersede ────────────────────────────────────────────
  it('supersede creates new memory and preserves old memory', () => {
    const store = createStore();
    const r = store.store({ content: 'v1 content' });
    const result = store.supersede(r.memory.memoryId, 'v2 content');
    assert.strictEqual(result.ok, true);
    // New memory exists with new content
    assert.strictEqual(result.newMemory.content, 'v2 content');
    assert.strictEqual(result.newMemory.status, 'active');
    assert.strictEqual(result.newMemory.supersedesMemoryId, r.memory.memoryId);
    // Old memory is marked superseded but content untouched
    assert.strictEqual(result.oldMemory.status, 'superseded');
    assert.strictEqual(result.oldMemory.content, 'v1 content');
  });

  it('supersede records link and event', () => {
    const store = createStore();
    const r = store.store({ content: 'original' });
    const result = store.supersede(r.memory.memoryId, 'updated');
    assert.ok(result.link);
    assert.strictEqual(result.link.relation, 'supersedes');
    assert.strictEqual(result.link.fromMemoryId, result.newMemory.memoryId);
    assert.strictEqual(result.link.toMemoryId, r.memory.memoryId);
    assert.ok(result.event);
    assert.strictEqual(result.event.details.action, 'supersede');
    assert.strictEqual(result.event.details.supersedesMemoryId, r.memory.memoryId);
  });

  it('supersede returns NOT_FOUND for unknown old id', () => {
    const store = createStore();
    const result = store.supersede('nonexistent', 'new content');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'NOT_FOUND');
  });

  it('supersede rejects missing new content', () => {
    const store = createStore();
    const r = store.store({ content: 'original' });
    const result = store.supersede(r.memory.memoryId, null);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'INVALID_INPUT');
  });

  // ── workspace isolation ──────────────────────────────────
  it('workspace isolation: memories are scoped to workspace', () => {
    const store = createStore();
    store.store({ content: 'ws-a memory', workspaceId: 'workspace-a' });
    store.store({ content: 'ws-b memory', workspaceId: 'workspace-b' });

    const listA = store.list({ workspaceId: 'workspace-a' });
    assert.strictEqual(listA.total, 1);
    assert.strictEqual(listA.memories[0].content, 'ws-a memory');

    const listB = store.list({ workspaceId: 'workspace-b' });
    assert.strictEqual(listB.total, 1);
    assert.strictEqual(listB.memories[0].content, 'ws-b memory');
  });

  it('get enforces workspace boundary', () => {
    const store = createStore();
    const r = store.store({ content: 'scoped', workspaceId: 'ws-x' });
    const result = store.get(r.memory.memoryId, { workspaceId: 'ws-y' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'NOT_FOUND');
  });

  // ── events and links ────────────────────────────────────
  it('getEvents returns events for a memory', () => {
    const store = createStore();
    const r = store.store({ content: 'tracked' });
    store.patchMetadata(r.memory.memoryId, { tag: 'v2' });
    const events = store.getEvents(r.memory.memoryId);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].eventType, 'CREATED');
    assert.strictEqual(events[1].eventType, 'UPDATED');
  });

  it('getLinks returns links for a memory after supersede', () => {
    const store = createStore();
    const r = store.store({ content: 'old' });
    const s = store.supersede(r.memory.memoryId, 'new');
    const links = store.getLinks(r.memory.memoryId);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].relation, 'supersedes');
  });

  // ── invalid memory fails validation ──────────────────────
  it('store with non-JSON-safe content fails', () => {
    const store = createStore();
    const circular = {};
    circular.self = circular;
    // store should gracefully handle — JSON.parse(JSON.stringify(...)) will throw
    // We test that it does not crash the store
    let threw = false;
    try {
      store.store({ content: circular });
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true);
  });
});
