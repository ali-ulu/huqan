'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MemoryStore = require('../lib/memory-store');

describe('PR-S6 workspace isolation stress', () => {
  it('keeps three workspaces isolated across store/list/query/link/timeline', () => {
    const store = new MemoryStore();
    const workspaces = ['ws-a', 'ws-b', 'ws-c'];
    const memoriesByWorkspace = new Map();

    for (const workspaceId of workspaces) {
      const records = [];
      for (let index = 0; index < 4; index += 1) {
        const res = store.store({
          workspaceId,
          content: {
            sharedClaim: `shared-${index}`,
            workspaceId,
            index,
          },
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.memory.workspaceId, workspaceId);
        assert.strictEqual(res.memory.status, 'active');
        records.push(res.memory);
      }
      memoriesByWorkspace.set(workspaceId, records);
    }

    const firstA = memoriesByWorkspace.get('ws-a')[0];
    const firstB = memoriesByWorkspace.get('ws-b')[0];
    const firstC = memoriesByWorkspace.get('ws-c')[0];
    assert.notStrictEqual(firstA.memoryId, firstB.memoryId);
    assert.notStrictEqual(firstA.memoryId, firstC.memoryId);
    assert.notStrictEqual(firstB.memoryId, firstC.memoryId);

    for (const workspaceId of workspaces) {
      const listRes = store.list({ workspaceId });
      const queryRes = store.query({ workspaceId });
      const timelineRes = store.timeline({ workspaceId });

      assert.strictEqual(listRes.ok, true);
      assert.strictEqual(queryRes.ok, true);
      assert.strictEqual(timelineRes.ok, true);
      assert.strictEqual(listRes.total, 4);
      assert.strictEqual(queryRes.total, 4);
      assert.strictEqual(timelineRes.total, 4);
      assert.ok(listRes.memories.every((record) => record.workspaceId === workspaceId));
      assert.ok(queryRes.memories.every((record) => record.workspaceId === workspaceId));
      assert.ok(timelineRes.events.every((event) => event.workspaceId === workspaceId));
    }

    for (const workspaceId of workspaces) {
      const records = memoriesByWorkspace.get(workspaceId);
      const linkRes = store.linkMemories({
        workspaceId,
        fromMemoryId: records[0].memoryId,
        toMemoryId: records[1].memoryId,
        relation: 'supports',
      });

      assert.strictEqual(linkRes.ok, true);
      assert.strictEqual(linkRes.link.workspaceId, workspaceId);
      assert.strictEqual(linkRes.event.workspaceId, workspaceId);

      const linksRes = store.queryLinks({ workspaceId });
      assert.strictEqual(linksRes.ok, true);
      assert.strictEqual(linksRes.total, 1);
      assert.strictEqual(linksRes.links[0].workspaceId, workspaceId);

      const linksForMemoryRes = store.linksForMemory(records[0].memoryId, { workspaceId });
      assert.strictEqual(linksForMemoryRes.ok, true);
      assert.strictEqual(linksForMemoryRes.links.length, 1);
      assert.strictEqual(linksForMemoryRes.links[0].workspaceId, workspaceId);

      const timelineRes = store.timeline({ workspaceId });
      assert.strictEqual(timelineRes.total, 5);
      assert.ok(timelineRes.events.every((event) => event.workspaceId === workspaceId));
      assert.ok(timelineRes.events.some((event) => event.eventType === 'LINKED'));
    }

    const crossWorkspaceLink = store.linkMemories({
      workspaceId: 'ws-a',
      fromMemoryId: memoriesByWorkspace.get('ws-a')[0].memoryId,
      toMemoryId: memoriesByWorkspace.get('ws-b')[0].memoryId,
      relation: 'supports',
    });
    assert.strictEqual(crossWorkspaceLink.ok, false);
    assert.strictEqual(crossWorkspaceLink.error.code, 'NOT_FOUND');

    assert.strictEqual(store.get(memoriesByWorkspace.get('ws-a')[0].memoryId, { workspaceId: 'ws-b' }).ok, false);
    assert.strictEqual(store.get(memoriesByWorkspace.get('ws-b')[0].memoryId, { workspaceId: 'ws-c' }).ok, false);
  });
});
