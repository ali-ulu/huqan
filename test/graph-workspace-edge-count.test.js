'use strict';

// #3139: a workspace-scoped edgeCount used to filter every edge. It now reads a
// per-workspace counter kept beside `_outIndex`/`_inIndex`. These tests pin that
// the counter never drifts from a scan of `_edges` across every path that adds
// or removes edges, and that a scoped count does not enumerate `_edges`.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Graph = require('../graph');
const { isolatedGraphOptions } = require('./helpers/isolated-persistence');

const WORKSPACES = ['default', 'team', 'missing'];

function scanCount(graph, workspaceId) {
  return graph._edges.filter(edge => (edge.workspaceId || 'default') === workspaceId).length;
}

function assertCountsMatchScan(graph, step) {
  for (const workspaceId of WORKSPACES) {
    assert.equal(graph.edgeCount(workspaceId), scanCount(graph, workspaceId), `${step}: ${workspaceId}`);
  }
  assert.equal(graph.edgeCount(), graph._edges.length, `${step}: total`);
}

function seed(graph) {
  for (const id of ['a', 'b', 'c']) {
    graph.addNode(id, 'thing', null, { workspaceId: 'default' });
    graph.addNode(id, 'thing', null, { workspaceId: 'team' });
  }
  graph.addEdge('a', 'b', 'rel', { workspaceId: 'default', weight: 0.9 });
  graph.addEdge('b', 'c', 'rel', { workspaceId: 'default', weight: 0.005 });
  graph.addEdge('a', 'c', 'rel', { workspaceId: 'team', weight: 0.9 });
}

for (const backend of ['json', 'sqlite']) {
  test(`[${backend}] GRAPH #3139: workspace edgeCount tracks every edge write path`, () => {
    const opts = isolatedGraphOptions(`graph-3139-${backend}`, { useSQLite: backend === 'sqlite' });
    const g = new Graph(opts);
    seed(g);
    assertCountsMatchScan(g, 'seed');

    // Reinforcing an existing edge updates it in place and must not recount it.
    g.addEdge('a', 'b', 'rel', { workspaceId: 'default', weight: 0.9 });
    assertCountsMatchScan(g, 'reinforce');

    g.prune(0.01, 'default');
    assertCountsMatchScan(g, 'prune');

    g.removeNode('a', 'team');
    assertCountsMatchScan(g, 'removeNode');

    g.addEdge('b', 'c', 'rel', { workspaceId: 'team', weight: 0.9 });
    g.consolidateEdges(false);
    assertCountsMatchScan(g, 'consolidate');

    assert.throws(() => g.runMutationOnce(`graph-3139-rollback-${backend}`, () => {
      g.addEdge('c', 'a', 'rel', { workspaceId: 'default', weight: 0.9 });
      throw new Error('abort');
    }), /abort/);
    assertCountsMatchScan(g, 'rollback');

    g.save();
    const reloaded = new Graph(opts);
    reloaded.load();
    assertCountsMatchScan(reloaded, 'reload');
    assert.equal(reloaded.edgeCount('default'), g.edgeCount('default'));
    g.close();
    reloaded.close();
  });
}

test('GRAPH #3139: an edge without a workspace id counts toward default, as the scan did', () => {
  const g = new Graph(isolatedGraphOptions('graph-3139-legacy', { useSQLite: false }));
  g._edges = [{ from: 'a', to: 'b', relation: 'rel' }];
  g.rebuildIndex();
  assert.equal(g.edgeCount('default'), 1);
});

test('GRAPH #3139: a workspace edgeCount does not enumerate the edge list', () => {
  const g = new Graph(isolatedGraphOptions('graph-3139-scan', { useSQLite: false }));
  for (let i = 0; i < 50; i++) g.addNode(`n${i}`, 'thing', null, { workspaceId: 'default' });
  for (let i = 1; i < 50; i++) g.addEdge(`n${i - 1}`, `n${i}`, 'next', { workspaceId: 'default' });

  let reads = 0;
  g._edges = new Proxy(g._edges, {
    get(target, key, receiver) {
      if (key !== 'length') reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });

  assert.equal(g.edgeCount('default'), 49);
  assert.equal(g.edgeCount('team'), 0);
  assert.equal(reads, 0, 'a scoped edgeCount must read the counter, not scan _edges');
});
