'use strict';

/**
 * Regression coverage for #397.
 *
 * traverseCausalGraph read `options.workspaceId` and reported it back in
 * `traversal.workspaceId`, but never passed it to the node/edge resolvers.
 * Graph's own reads take workspaceId as a second argument defaulting to
 * 'default', so a traversal scoped to another workspace silently walked the
 * default one -- while still labelling the result with the caller's workspace.
 *
 * That is the worst shape for a scoping bug: the output looks correctly scoped.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { traverseCausalGraph } = require('../lib/causal');
const Graph = require('../graph');

/** Records the workspaceId each read was given, so the threading is observable. */
function spyGraph() {
  const calls = { getNode: [], getCausalEdges: [] };
  return {
    calls,
    getNode(id, workspaceId) {
      calls.getNode.push({ id, workspaceId });
      return { id };
    },
    getCausalEdges(id, workspaceId) {
      calls.getCausalEdges.push({ id, workspaceId });
      return [];
    },
  };
}

test('workspaceId is forwarded to the node and edge resolvers (#397)', () => {
  const graph = spyGraph();
  traverseCausalGraph(graph, 'a', { workspaceId: 'tenant-b' });

  assert.ok(graph.calls.getNode.length > 0);
  for (const call of graph.calls.getNode) {
    assert.equal(call.workspaceId, 'tenant-b', `getNode(${call.id})`);
  }
  for (const call of graph.calls.getCausalEdges) {
    assert.equal(call.workspaceId, 'tenant-b', `getCausalEdges(${call.id})`);
  }
});

test('no workspaceId option leaves the argument off, as before (#397)', () => {
  const graph = spyGraph();
  traverseCausalGraph(graph, 'a', {});

  assert.ok(graph.calls.getNode.length > 0);
  for (const call of graph.calls.getNode) {
    assert.equal(call.workspaceId, undefined);
  }
});

test('a blank workspaceId is treated as absent, as before (#397)', () => {
  const graph = spyGraph();
  traverseCausalGraph(graph, 'a', { workspaceId: '   ' });
  assert.equal(graph.calls.getNode[0].workspaceId, undefined);
});

test('a traversal scoped to a workspace does not walk the default one (#397)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-causal-ws-'));
  const graph = new Graph({ memoryPath: path.join(root, 'memory.json') });
  try {
    // Same node id in two workspaces, with different causal successors.
    graph.addNode('kok', 'Kök', null, { workspaceId: 'default' });
    graph.addNode('default-sonuc', 'Default sonuç', null, { workspaceId: 'default' });
    graph.addEdge('kok', 'default-sonuc', 'CAUSES', { workspaceId: 'default', confidence: 0.9, strength: 0.9 });

    graph.addNode('kok', 'Kök', null, { workspaceId: 'tenant-b' });
    graph.addNode('tenant-sonuc', 'Tenant sonuç', null, { workspaceId: 'tenant-b' });
    graph.addEdge('kok', 'tenant-sonuc', 'CAUSES', { workspaceId: 'tenant-b', confidence: 0.9, strength: 0.9 });

    const scoped = traverseCausalGraph(graph, 'kok', { workspaceId: 'tenant-b' });
    const reached = scoped.traversal.traversalOrder.map(entry => entry.to);

    assert.equal(scoped.traversal.workspaceId, 'tenant-b');
    assert.ok(
      !reached.includes('default-sonuc'),
      `traversal scoped to tenant-b leaked into the default workspace: ${JSON.stringify(reached)}`,
    );
    assert.deepEqual(reached, ['tenant-sonuc']);
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a node that exists only in another workspace is not a valid start (#397)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-causal-ws2-'));
  const graph = new Graph({ memoryPath: path.join(root, 'memory.json') });
  try {
    graph.addNode('sadece-default', 'Sadece default', null, { workspaceId: 'default' });

    const scoped = traverseCausalGraph(graph, 'sadece-default', { workspaceId: 'tenant-b' });

    assert.equal(scoped.traversal.stopReason, 'missing_start');
    assert.equal(scoped.traversal.workspaceId, 'tenant-b');
  } finally {
    graph.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
