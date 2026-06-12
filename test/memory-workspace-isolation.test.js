const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const Kernel = require('../kernel');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeProvenance(workspaceId, sourceRef, timestamp) {
  return {
    provenanceId: `${workspaceId}:${sourceRef}:prov`,
    sourceRef,
    sourceTitle: sourceRef,
    sourceType: 'document',
    actor: 'system',
    timestamp,
    confidence: 0.99,
    workspaceId,
    trustPolicyVersion: '1.0.0',
  };
}

function createWorkspaceRecord({ workspaceId, memoryId, text, createdAt, sourceRef }) {
  return {
    memoryId,
    workspaceId,
    content: { text },
    createdAt,
    updatedAt: createdAt,
    provenance: makeProvenance(workspaceId, sourceRef, createdAt),
    trustPolicyVersion: '1.0.0',
    status: 'active',
    metadata: { workspaceId, text },
    contentHash: `${workspaceId}-${memoryId}-${text}`,
  };
}

function createKernel(memoryPath) {
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    memoryStorePath: memoryPath,
  });
}

describe('memory workspace isolation', () => {
  it('keeps identical memory ids isolated when stored under workspace keys', () => {
    const kernel = createKernel();
    const sharedId = 'shared-memory-id';

    kernel.memory._memories.set('ws-a:' + sharedId, createWorkspaceRecord({
      workspaceId: 'ws-a',
      memoryId: sharedId,
      text: 'alpha',
      createdAt: '2026-06-12T01:00:00.000Z',
      sourceRef: 'docs/alpha.md#1',
    }));
    kernel.memory._memories.set('ws-b:' + sharedId, createWorkspaceRecord({
      workspaceId: 'ws-b',
      memoryId: sharedId,
      text: 'beta',
      createdAt: '2026-06-12T01:00:01.000Z',
      sourceRef: 'docs/beta.md#1',
    }));

    const foundA = kernel.memory.get(sharedId, { workspaceId: 'ws-a' });
    const foundB = kernel.memory.get(sharedId, { workspaceId: 'ws-b' });
    assert.strictEqual(foundA.ok, true);
    assert.strictEqual(foundB.ok, true);
    assert.strictEqual(foundA.memory.content.text, 'alpha');
    assert.strictEqual(foundB.memory.content.text, 'beta');

    const listA = kernel.memory.list({ workspaceId: 'ws-a' });
    const listB = kernel.memory.list({ workspaceId: 'ws-b' });
    assert.strictEqual(listA.total, 1);
    assert.strictEqual(listB.total, 1);
    assert.strictEqual(listA.memories[0].content.text, 'alpha');
    assert.strictEqual(listB.memories[0].content.text, 'beta');

    const searchA = kernel.memory.search('beta', { workspaceId: 'ws-a' });
    const searchB = kernel.memory.search('beta', { workspaceId: 'ws-b' });
    assert.strictEqual(searchA.total, 0);
    assert.strictEqual(searchB.total, 1);

    const timelineA = kernel.memory.timeline({ workspaceId: 'ws-a' });
    const timelineB = kernel.memory.timeline({ workspaceId: 'ws-b' });
    assert.strictEqual(timelineA.total, 1);
    assert.strictEqual(timelineB.total, 1);
    assert.ok(timelineA.memories.every((record) => record.workspaceId === 'ws-a'));
    assert.ok(timelineB.memories.every((record) => record.workspaceId === 'ws-b'));
  });

  it('keeps links, traversal, temporal queries, and reloads workspace-scoped', () => {
    const dir = makeTempDir('axiom-m6-workspace-');
    const memoryPath = path.join(dir, 'memory.json');
    const kernel = createKernel(memoryPath);

    const aRoot = kernel.memory.store({
      content: { text: 'alpha root' },
      workspaceId: 'ws-a',
      provenance: makeProvenance('ws-a', 'docs/a-root.md#1', '2026-06-12T02:00:00.000Z'),
    });
    const aChild = kernel.memory.store({
      content: { text: 'alpha child' },
      workspaceId: 'ws-a',
      provenance: makeProvenance('ws-a', 'docs/a-child.md#1', '2026-06-12T02:00:01.000Z'),
    });
    const bRoot = kernel.memory.store({
      content: { text: 'beta root' },
      workspaceId: 'ws-b',
      provenance: makeProvenance('ws-b', 'docs/b-root.md#1', '2026-06-12T02:00:02.000Z'),
    });
    const bChild = kernel.memory.store({
      content: { text: 'beta child' },
      workspaceId: 'ws-b',
      provenance: makeProvenance('ws-b', 'docs/b-child.md#1', '2026-06-12T02:00:03.000Z'),
    });

    assert.strictEqual(aRoot.ok, true);
    assert.strictEqual(aChild.ok, true);
    assert.strictEqual(bRoot.ok, true);
    assert.strictEqual(bChild.ok, true);

    const linkA = kernel.memory.link({
      fromMemoryId: aRoot.memory.memoryId,
      toMemoryId: aChild.memory.memoryId,
      relation: 'supports',
      workspaceId: 'ws-a',
    });
    const linkB = kernel.memory.link({
      fromMemoryId: bRoot.memory.memoryId,
      toMemoryId: bChild.memory.memoryId,
      relation: 'supports',
      workspaceId: 'ws-b',
    });
    assert.strictEqual(linkA.ok, true);
    assert.strictEqual(linkB.ok, true);

    const listA = kernel.memory.list({ workspaceId: 'ws-a' });
    const listB = kernel.memory.list({ workspaceId: 'ws-b' });
    assert.strictEqual(listA.total, 2);
    assert.strictEqual(listB.total, 2);

    const searchA = kernel.memory.search('beta', { workspaceId: 'ws-a' });
    const searchB = kernel.memory.search('beta', { workspaceId: 'ws-b' });
    assert.strictEqual(searchA.total, 0);
    assert.strictEqual(searchB.total, 2);

    const linksA = kernel.memory.getLinks(aRoot.memory.memoryId, { workspaceId: 'ws-a' });
    const linksB = kernel.memory.getLinks(aRoot.memory.memoryId, { workspaceId: 'ws-b' });
    assert.strictEqual(linksA.length, 1);
    assert.strictEqual(linksB.length, 0);

    const traversalA = kernel.memory.traverseLinks(aRoot.memory.memoryId, { workspaceId: 'ws-a', maxDepth: 2 });
    assert.strictEqual(traversalA.ok, true);
    assert.deepStrictEqual(traversalA.nodes.map((record) => record.memoryId), [
      aRoot.memory.memoryId,
      aChild.memory.memoryId,
    ]);
    assert.ok(traversalA.nodes.every((record) => record.workspaceId === 'ws-a'));

    const traversalWrongWorkspace = kernel.memory.traverseLinks(aRoot.memory.memoryId, { workspaceId: 'ws-b', maxDepth: 2 });
    assert.strictEqual(traversalWrongWorkspace.ok, false);
    assert.strictEqual(traversalWrongWorkspace.error.code, 'NOT_FOUND');

    const timelineA = kernel.memory.timeline({ workspaceId: 'ws-a' });
    const timelineB = kernel.memory.timeline({ workspaceId: 'ws-b' });
    assert.strictEqual(timelineA.total, 2);
    assert.strictEqual(timelineB.total, 2);
    assert.ok(timelineA.memories.every((record) => record.workspaceId === 'ws-a'));
    assert.ok(timelineB.memories.every((record) => record.workspaceId === 'ws-b'));

    const saveResult = kernel.memory.save();
    assert.strictEqual(saveResult.ok, true);
    assert.strictEqual(saveResult.backend, 'json');

    const reopened = new Kernel({
      loadPlugins: false,
      memoryStorePath: memoryPath,
    });

    const reopenedA = reopened.memory.list({ workspaceId: 'ws-a' });
    const reopenedB = reopened.memory.list({ workspaceId: 'ws-b' });
    assert.strictEqual(reopenedA.total, 2);
    assert.strictEqual(reopenedB.total, 2);
    assert.ok(reopenedA.memories.every((record) => record.workspaceId === 'ws-a'));
    assert.ok(reopenedB.memories.every((record) => record.workspaceId === 'ws-b'));

    const reopenedSearch = reopened.memory.search('beta', { workspaceId: 'ws-a' });
    assert.strictEqual(reopenedSearch.total, 0);

    const reopenedLinks = reopened.memory.getLinks(aRoot.memory.memoryId, { workspaceId: 'ws-a' });
    assert.strictEqual(reopenedLinks.length, 1);
    assert.strictEqual(reopenedLinks[0].relation, 'supports');

    reopened.memory.close();
    kernel.memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
