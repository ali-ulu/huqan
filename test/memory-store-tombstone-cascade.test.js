'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');

describe('PR-S6 tombstone and supersede cascade', () => {
  it('hides tombstoned memories and their links from active queries', () => {
    const store = new MemoryStore();

    const m1 = store.store({ content: 'alpha', workspaceId: 'ws-a' }).memory;
    const m2 = store.store({ content: 'beta', workspaceId: 'ws-a' }).memory;
    const m3 = store.store({ content: 'gamma', workspaceId: 'ws-a' }).memory;

    const link1 = store.linkMemories({
      workspaceId: 'ws-a',
      fromMemoryId: m1.memoryId,
      toMemoryId: m2.memoryId,
      relation: 'supports',
    });
    const link2 = store.linkMemories({
      workspaceId: 'ws-a',
      fromMemoryId: m2.memoryId,
      toMemoryId: m3.memoryId,
      relation: 'references',
    });

    assert.strictEqual(link1.ok, true);
    assert.strictEqual(link2.ok, true);

    const tombRes = store.tombstone(m2.memoryId, { workspaceId: 'ws-a' });
    assert.strictEqual(tombRes.ok, true);
    assert.strictEqual(tombRes.memory.status, 'deleted');

    const listRes = store.list({ workspaceId: 'ws-a' });
    assert.strictEqual(listRes.total, 2);
    assert.deepStrictEqual(listRes.memories.map((m) => m.content), ['alpha', 'gamma']);

    const queryRes = store.query({ workspaceId: 'ws-a' });
    assert.strictEqual(queryRes.total, 2);
    assert.deepStrictEqual(queryRes.memories.map((m) => m.content), ['alpha', 'gamma']);

    const queryIncludeDeleted = store.query({ workspaceId: 'ws-a', includeDeleted: true });
    assert.strictEqual(queryIncludeDeleted.total, 3);
    assert.ok(queryIncludeDeleted.memories.some((m) => m.status === 'deleted'));

    const linksDefault = store.queryLinks({ workspaceId: 'ws-a' });
    assert.strictEqual(linksDefault.total, 0);

    const linksIncludeDeleted = store.queryLinks({ workspaceId: 'ws-a', includeDeleted: true });
    assert.strictEqual(linksIncludeDeleted.total, 2);
    assert.ok(linksIncludeDeleted.links.every((link) => link.workspaceId === 'ws-a'));

    const linksForTombstonedDefault = store.linksForMemory(m2.memoryId, { workspaceId: 'ws-a' });
    assert.strictEqual(linksForTombstonedDefault.links.length, 0);

    const linksForTombstonedInclude = store.linksForMemory(m2.memoryId, { workspaceId: 'ws-a', includeDeleted: true });
    assert.strictEqual(linksForTombstonedInclude.links.length, 2);

    const auditLinks = store.getLinks(m2.memoryId);
    assert.strictEqual(auditLinks.length, 2);

    const timelineRes = store.timeline({ workspaceId: 'ws-a' });
    assert.strictEqual(timelineRes.total, 6);
    assert.ok(timelineRes.events.some((event) => event.eventType === 'TOMBSTONE'));
    assert.ok(timelineRes.events.every((event) => event.workspaceId === 'ws-a'));
  });

  it('hides superseded memories and supersede links from active queries', () => {
    const store = new MemoryStore();

    const original = store.store({ content: 'v1', workspaceId: 'ws-a' }).memory;
    const companion = store.store({ content: 'ws-b companion', workspaceId: 'ws-b' }).memory;
    const supersedeRes = store.supersede(original.memoryId, 'v2', { workspaceId: 'ws-a' });

    assert.strictEqual(supersedeRes.ok, true);
    assert.strictEqual(supersedeRes.oldMemory.status, 'superseded');
    assert.strictEqual(supersedeRes.newMemory.status, 'active');

    const listRes = store.list({ workspaceId: 'ws-a' });
    assert.strictEqual(listRes.total, 1);
    assert.strictEqual(listRes.memories[0].content, 'v2');

    const queryRes = store.query({ workspaceId: 'ws-a' });
    assert.strictEqual(queryRes.total, 1);
    assert.strictEqual(queryRes.memories[0].content, 'v2');

    const supersededQuery = store.query({ workspaceId: 'ws-a', status: 'superseded' });
    assert.strictEqual(supersededQuery.total, 1);
    assert.strictEqual(supersededQuery.memories[0].content, 'v1');

    const linksDefault = store.queryLinks({ workspaceId: 'ws-a' });
    assert.strictEqual(linksDefault.total, 0);

    const linksIncludeDeleted = store.queryLinks({ workspaceId: 'ws-a', includeDeleted: true });
    assert.strictEqual(linksIncludeDeleted.total, 1);
    assert.strictEqual(linksIncludeDeleted.links[0].relation, 'supersedes');

    const linksForOriginalDefault = store.linksForMemory(original.memoryId, { workspaceId: 'ws-a' });
    assert.strictEqual(linksForOriginalDefault.links.length, 0);

    const linksForOriginalInclude = store.linksForMemory(original.memoryId, { workspaceId: 'ws-a', includeDeleted: true });
    assert.strictEqual(linksForOriginalInclude.links.length, 1);

    const auditLinks = store.getLinks(original.memoryId);
    assert.strictEqual(auditLinks.length, 1);

    const wsBQuery = store.query({ workspaceId: 'ws-b' });
    assert.strictEqual(wsBQuery.total, 1);
    assert.strictEqual(wsBQuery.memories[0].memoryId, companion.memoryId);

    const timelineRes = store.timeline({ workspaceId: 'ws-a' });
    assert.ok(timelineRes.events.some((event) => event.eventType === 'UPDATED' && event.details && event.details.newStatus === 'superseded'));
    assert.ok(timelineRes.events.every((event) => event.workspaceId === 'ws-a'));
  });
});
