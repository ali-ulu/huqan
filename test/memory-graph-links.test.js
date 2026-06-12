const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Kernel = require('../kernel');

function createKernel() {
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeProvenance(workspaceId, sourceRef, timestamp) {
  return {
    provenanceId: sourceRef + '-prov',
    sourceRef,
    sourceTitle: sourceRef,
    sourceType: 'document',
    actor: 'system',
    timestamp,
    confidence: 0.98,
    workspaceId,
    trustPolicyVersion: '1.0.0',
  };
}

describe('memory graph links', () => {
  it('creates deterministic links, preserves provenance, and traverses neighborhoods within one workspace', async () => {
    const kernel = createKernel();

    const root = kernel.memory.store({
      content: { text: 'root' },
      workspaceId: 'ws-graph',
      provenance: makeProvenance('ws-graph', 'docs/root.md#1', '2026-06-12T00:00:00.000Z'),
    });
    await delay(15);
    const child = kernel.memory.store({
      content: { text: 'child' },
      workspaceId: 'ws-graph',
      provenance: makeProvenance('ws-graph', 'docs/child.md#1', '2026-06-12T00:00:01.000Z'),
    });
    await delay(15);
    const leaf = kernel.memory.store({
      content: { text: 'leaf' },
      workspaceId: 'ws-graph',
      provenance: makeProvenance('ws-graph', 'docs/leaf.md#1', '2026-06-12T00:00:02.000Z'),
    });
    await delay(15);
    const otherWorkspace = kernel.memory.store({
      content: { text: 'other workspace' },
      workspaceId: 'ws-other',
      provenance: makeProvenance('ws-other', 'docs/other.md#1', '2026-06-12T00:00:03.000Z'),
    });

    assert.strictEqual(root.ok, true);
    assert.strictEqual(child.ok, true);
    assert.strictEqual(leaf.ok, true);
    assert.strictEqual(otherWorkspace.ok, true);

    const supportLink = kernel.memory.link({
      fromMemoryId: root.memory.memoryId,
      toMemoryId: child.memory.memoryId,
      relation: 'supports',
      workspaceId: 'ws-graph',
      provenance: makeProvenance('ws-graph', 'docs/link-support.md#1', '2026-06-12T00:00:04.000Z'),
    });
    assert.strictEqual(supportLink.ok, true);
    assert.strictEqual(supportLink.link.provenance.sourceRef, 'docs/link-support.md#1');

    const duplicate = kernel.memory.link({
      fromMemoryId: root.memory.memoryId,
      toMemoryId: child.memory.memoryId,
      relation: 'supports',
      workspaceId: 'ws-graph',
      provenance: makeProvenance('ws-graph', 'docs/link-support.md#1', '2026-06-12T00:00:05.000Z'),
    });
    assert.strictEqual(duplicate.ok, true);
    assert.strictEqual(duplicate.deduped, true);

    const relatedLink = kernel.memory.link({
      fromMemoryId: child.memory.memoryId,
      toMemoryId: leaf.memory.memoryId,
      relation: 'related_to',
      workspaceId: 'ws-graph',
      provenance: makeProvenance('ws-graph', 'docs/link-related.md#1', '2026-06-12T00:00:06.000Z'),
    });
    assert.strictEqual(relatedLink.ok, true);

    const backlinks = kernel.memory.getBacklinks(child.memory.memoryId, { workspaceId: 'ws-graph' });
    assert.deepStrictEqual(backlinks.map((link) => link.linkId), [supportLink.link.linkId]);

    const outgoing = kernel.memory.getLinks(root.memory.memoryId, { workspaceId: 'ws-graph' });
    assert.deepStrictEqual(outgoing.map((link) => link.linkId), [supportLink.link.linkId]);

    const isolated = kernel.memory.getLinks(root.memory.memoryId, { workspaceId: 'ws-other' });
    assert.deepStrictEqual(isolated, []);

    const traversal = kernel.memory.traverseLinks(root.memory.memoryId, {
      workspaceId: 'ws-graph',
      maxDepth: 2,
    });
    assert.strictEqual(traversal.ok, true);
    assert.deepStrictEqual(traversal.nodes.map((record) => record.memoryId), [
      root.memory.memoryId,
      child.memory.memoryId,
      leaf.memory.memoryId,
    ]);
    assert.deepStrictEqual(traversal.links.map((link) => link.linkId), [
      supportLink.link.linkId,
      relatedLink.link.linkId,
    ]);

    const traversalAgain = kernel.memory.traverseLinks(root.memory.memoryId, {
      workspaceId: 'ws-graph',
      maxDepth: 2,
    });
    assert.deepStrictEqual(traversalAgain.nodes.map((record) => record.memoryId), traversal.nodes.map((record) => record.memoryId));
    assert.deepStrictEqual(traversalAgain.links.map((link) => link.linkId), traversal.links.map((link) => link.linkId));

    const tombstoned = kernel.memory.tombstone(child.memory.memoryId, { workspaceId: 'ws-graph' });
    assert.strictEqual(tombstoned.ok, true);

    const withTombstones = kernel.memory.traverseLinks(root.memory.memoryId, {
      workspaceId: 'ws-graph',
      maxDepth: 2,
      includeTombstoned: true,
    });
    assert.strictEqual(withTombstones.ok, true);
    assert.ok(withTombstones.nodes.some((record) => record.memoryId === child.memory.memoryId));
    assert.ok(withTombstones.links.some((link) => link.linkId === supportLink.link.linkId));

    const crossWorkspaceTraversal = kernel.memory.traverseLinks(root.memory.memoryId, {
      workspaceId: 'ws-other',
      maxDepth: 2,
    });
    assert.strictEqual(crossWorkspaceTraversal.ok, false);
    assert.strictEqual(crossWorkspaceTraversal.error.code, 'NOT_FOUND');
  });

  it('rejects empty graph helper inputs safely', () => {
    const kernel = createKernel();
    assert.deepStrictEqual(kernel.memory.getBacklinks('', { workspaceId: 'ws-graph' }), []);
    assert.strictEqual(kernel.memory.traverseLinks('', { workspaceId: 'ws-graph' }).ok, false);
  });
});
