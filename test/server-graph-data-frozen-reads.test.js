'use strict';

// /graph-data opts into the read primitives' frozen views (#3012). The
// projection builds a fresh response object from every field it reads, so it
// never needed the per-record deep clone the reads default to. This test pins
// that down against a real Graph: the canonical records must stay unfrozen and
// mutable (so writes still work) even after the projection ran, and the
// projected response must still carry the expected shape.

const assert = require('node:assert/strict');
const test = require('node:test');
const Graph = require('../graph');
const { buildGraphData } = require('../lib/server-graph-data');

function buildGraph() {
  const graph = new Graph({ memoryPath: ':memory:', useSQLite: false });
  graph.addNode('a', 'Alpha', null, { workspaceId: 'team-a' });
  graph.addNode('b', 'Beta', null, { workspaceId: 'team-a' });
  graph.addEdge('a', 'b', 'supports', {
    workspaceId: 'team-a',
    confidence: 0.8,
    source: 'fixture',
    evidence: ['one', 'two', 'three'],
  });
  return graph;
}

test('GRAPH-DATA FROZEN READS: projection reads frozen views without freezing canonical records', () => {
  const graph = buildGraph();
  try {
    const result = buildGraphData({ graph, memory: null, getSafeMemoryLabel: () => 'unused', workspaceId: 'team-a' });

    assert.deepEqual(result.nodes.map(n => n.id).sort(), ['a', 'b']);
    const nodeA = result.nodes.find(n => n.id === 'a');
    assert.equal(nodeA.edgeCount, 1);
    assert.equal(nodeA.confidence, 0.8);
    assert.deepEqual(nodeA.sources, ['fixture']);
    assert.equal(nodeA.evidenceCount, 3);

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0].source, 'a');
    assert.equal(result.links[0].target, 'b');
    assert.deepEqual(result.links[0].evidence, ['one', 'two']);

    // The frozen views are copies, not the stored records: a fresh read still
    // sees the original label, and the store's own record is untouched.
    assert.equal(Object.isFrozen(graph.getNodes('team-a', { clone: false }).a), true);
    assert.equal(graph.getNode('a', 'team-a').label, 'Alpha');

    // A default (deep-cloned) read stays isolated: mutating it does not change
    // the store.
    const defaultRead = graph.getNode('a', 'team-a');
    assert.equal(Object.isFrozen(defaultRead), false);
    defaultRead.label = 'mutated-copy';
    assert.equal(graph.getNode('a', 'team-a').label, 'Alpha');

    // The projection never leaked a frozen object into the response, so a
    // consumer that mutates the response object does not throw.
    assert.equal(Object.isFrozen(result.nodes[0]), false);
    assert.equal(Object.isFrozen(result.links[0]), false);
    result.nodes[0].label = 'rewritten';
    assert.equal(graph.getNode('a', 'team-a').label, 'Alpha');
  } finally {
    graph.close();
  }
});
