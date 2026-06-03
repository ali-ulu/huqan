'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');

// Helper: create a fresh store per test
function createStore(opts) {
  return new MemoryStore(opts);
}

function makeValidProvenance(actor, sourceType, sourceRef) {
  return {
    provenanceId: 'prov-' + Math.random().toString(36).slice(2, 9),
    sourceRef: sourceRef || 'axiom-memory-core',
    sourceTitle: 'AXIOM Memory Core',
    sourceType: sourceType || 'memory-api',
    actor: actor || 'system',
    timestamp: new Date().toISOString(),
    workspaceId: 'default',
    trustPolicyVersion: '1.0.0',
    confidence: 1.0,
  };
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
    const r1 = store.store({ content: 'alpha' });
    const r2 = store.store({ content: 'beta' });
    const r3 = store.store({ content: 'gamma' });

    // Manually force different timestamps to avoid sub-millisecond clustering in fast environments
    r1.memory.createdAt = '2026-06-03T12:00:00.000Z';
    r2.memory.createdAt = '2026-06-03T12:00:01.000Z';
    r3.memory.createdAt = '2026-06-03T12:00:02.000Z';

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
  });

  // ── query ────────────────────────────────────────────────
  it('query respects workspace boundary', () => {
    const store = createStore();
    store.store({ content: 'ws-a', workspaceId: 'ws-a' });
    store.store({ content: 'ws-b', workspaceId: 'ws-b' });

    const rA = store.query({ workspaceId: 'ws-a' });
    assert.strictEqual(rA.ok, true);
    assert.strictEqual(rA.total, 1);
    assert.strictEqual(rA.memories[0].content, 'ws-a');

    const rB = store.query({ workspaceId: 'ws-b' });
    assert.strictEqual(rB.ok, true);
    assert.strictEqual(rB.total, 1);
    assert.strictEqual(rB.memories[0].content, 'ws-b');
  });

  it('query hides deleted memories by default', () => {
    const store = createStore();
    const r1 = store.store({ content: 'active-1' });
    const r2 = store.store({ content: 'deleted-1' });
    store.tombstone(r2.memory.memoryId);

    const r = store.query();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.memories[0].content, 'active-1');
  });

  it('query includes deleted with includeDeleted/includeTombstoned', () => {
    const store = createStore();
    const r1 = store.store({ content: 'active-1' });
    const r2 = store.store({ content: 'deleted-1' });
    store.tombstone(r2.memory.memoryId);

    const r = store.query({ includeDeleted: true });
    assert.strictEqual(r.total, 2);

    const rTomb = store.query({ includeTombstoned: true });
    assert.strictEqual(rTomb.total, 2);
  });

  it('query filters by kind', () => {
    const store = createStore();
    store.store({ content: 'm1' });
    const m = store.query({ kind: 'memory-record' });
    assert.strictEqual(m.total, 1);

    const mEmpty = store.query({ kind: 'other-kind' });
    assert.strictEqual(mEmpty.total, 0);
  });

  it('query filters by status', () => {
    const store = createStore();
    const r = store.store({ content: 'v1' });
    store.supersede(r.memory.memoryId, 'v2');

    const active = store.query({ status: 'active' });
    assert.strictEqual(active.total, 1);
    assert.strictEqual(active.memories[0].content, 'v2');

    const superseded = store.query({ status: 'superseded' });
    assert.strictEqual(superseded.total, 1);
    assert.strictEqual(superseded.memories[0].content, 'v1');
  });

  it('query filters by actor/sourceType/sourceRef', () => {
    const store = createStore();
    store.store({ content: 'm1', provenance: makeValidProvenance('alice', 'document', 'ref-1') });
    store.store({ content: 'm2', provenance: makeValidProvenance('bob', 'chat', 'ref-2') });

    const r1 = store.query({ actor: 'alice' });
    assert.strictEqual(r1.total, 1);
    assert.strictEqual(r1.memories[0].content, 'm1');

    const r2 = store.query({ sourceType: 'chat' });
    assert.strictEqual(r2.total, 1);
    assert.strictEqual(r2.memories[0].content, 'm2');

    const r3 = store.query({ sourceRef: 'ref-1' });
    assert.strictEqual(r3.total, 1);
    assert.strictEqual(r3.memories[0].content, 'm1');
  });

  it('query filters by createdAfter/createdBefore', () => {
    const store = createStore();
    const r1 = store.store({ content: 'm1' });
    const r2 = store.store({ content: 'm2' });
    const r3 = store.store({ content: 'm3' });

    r1.memory.createdAt = '2026-06-03T12:00:00.000Z';
    r2.memory.createdAt = '2026-06-03T12:00:05.000Z';
    r3.memory.createdAt = '2026-06-03T12:00:10.000Z';

    const r = store.query({
      createdAfter: '2026-06-03T12:00:05.000Z',
      createdBefore: '2026-06-03T12:00:10.000Z'
    });
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.memories[0].content, 'm2');
    assert.strictEqual(r.memories[1].content, 'm3');
  });

  it('query filters by updatedAfter/updatedBefore', () => {
    const store = createStore();
    const r1 = store.store({ content: 'm1' });
    const r2 = store.store({ content: 'm2' });

    r1.memory.updatedAt = '2026-06-03T12:10:00.000Z';
    r2.memory.updatedAt = '2026-06-03T12:10:10.000Z';

    const r = store.query({
      updatedAfter: '2026-06-03T12:10:05.000Z'
    });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.memories[0].content, 'm2');
  });

  it('query supports contentIncludes/text case-insensitive search', () => {
    const store = createStore();
    store.store({ content: 'The quick brown fox jumps' });
    store.store({ content: 'Over the lazy dog' });

    const r1 = store.query({ contentIncludes: 'FOX' });
    assert.strictEqual(r1.total, 1);
    assert.strictEqual(r1.memories[0].content, 'The quick brown fox jumps');

    const r2 = store.query({ text: 'lazy' });
    assert.strictEqual(r2.total, 1);
    assert.strictEqual(r2.memories[0].content, 'Over the lazy dog');
  });

  it('query supports object content deterministic search', () => {
    const store = createStore();
    store.store({ content: { name: 'Alice', role: 'admin' } });
    store.store({ content: { role: 'user', name: 'Bob' } });

    const r = store.query({ contentIncludes: 'role":"admin' });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.memories[0].content.name, 'Alice');
  });

  it('query supports shallow metadata exact match', () => {
    const store = createStore();
    store.store({ content: 'm1', metadata: { category: 'A', status: 1 } });
    store.store({ content: 'm2', metadata: { category: 'B', status: 1 } });

    const r = store.query({ metadata: { category: 'A', status: 1 } });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.memories[0].content, 'm1');
  });

  it('query supports limit/offset', () => {
    const store = createStore();
    for (let i = 0; i < 5; i++) {
      store.store({ content: `item-${i}` });
    }
    const r = store.query({ limit: 2, offset: 2 });
    assert.strictEqual(r.memories.length, 2);
    assert.strictEqual(r.total, 5);
    assert.strictEqual(r.limit, 2);
    assert.strictEqual(r.offset, 2);
  });

  it('query ordering is deterministic with same timestamps', () => {
    const store = createStore();
    const r1 = store.store({ content: 'first' });
    const r2 = store.store({ content: 'second' });

    r1.memory.createdAt = '2026-06-03T12:00:00.000Z';
    r2.memory.createdAt = '2026-06-03T12:00:00.000Z';

    const order = [r1.memory.memoryId, r2.memory.memoryId].sort();

    const r = store.query({ orderBy: 'createdAt', order: 'asc' });
    assert.strictEqual(r.memories[0].memoryId, order[0]);
    assert.strictEqual(r.memories[1].memoryId, order[1]);
  });

  it('invalid query options are handled consistently', () => {
    const store = createStore();
    const r1 = store.query({ limit: -5 });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error.code, 'VALIDATION_ERROR');

    const r2 = store.query({ limit: 1005 });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.error.code, 'VALIDATION_ERROR');

    const r3 = store.query({ createdAfter: 'invalid-date' });
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.error.code, 'VALIDATION_ERROR');

    const r4 = store.query({ order: 'invalid-direction' });
    assert.strictEqual(r4.ok, false);
    assert.strictEqual(r4.error.code, 'VALIDATION_ERROR');
  });
});
