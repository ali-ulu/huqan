'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { getNode, getNodes } = require('../lib/graph-node-read');
const { query } = require('../lib/graph-query-read');
const {
  getAllEdges,
  getEdge,
  getEdges,
  getEdgesBetween,
  getInEdges,
  hasAnyEdge,
} = require('../lib/graph-edge-read');
const { edgeIndexKey } = require('../lib/graph-record-utils');

function nodeFixtures() {
  return {
    a: { id: 'a', label: 'L', workspaceId: 'default', tags: ['t'], provenance: { p: 1 } },
    b: { id: 'b', label: 'L', workspaceId: 'default' },
    c: { id: 'c', label: 'L', workspaceId: 'default' },
    d: { id: 'd', label: 'other', workspaceId: 'default' },
    'team::a': { id: 'a', label: 'L', workspaceId: 'team' },
  };
}

function edgeFixtures() {
  const edges = [
    { from: 'a', to: 'b', relation: 'r', workspaceId: 'default', evidence: ['e1'], meta: { m: 1 } },
    { from: 'a', to: 'c', relation: 'r', workspaceId: 'default' },
    { from: 'a', to: 'd', relation: 'r', workspaceId: 'default' },
  ];
  const outIndex = new Map([[edgeIndexKey('a', 'default'), edges]]);
  const inIndex = new Map([
    [edgeIndexKey('b', 'default'), [edges[0]]],
    [edgeIndexKey('c', 'default'), [edges[1]]],
  ]);
  return { edges, outIndex, inIndex };
}

test('GRAPH BOUNDS: getNodes supports limit/offset without changing the default', () => {
  const nodes = nodeFixtures();
  assert.equal(Object.keys(getNodes(nodes, 'default')).length, 4);
  assert.deepEqual(Object.keys(getNodes(nodes, 'default', { limit: 2 })), ['a', 'b']);
  assert.deepEqual(Object.keys(getNodes(nodes, 'default', { limit: 1, offset: 1 })), ['b']);
  assert.deepEqual(Object.keys(getNodes(nodes, { workspaceId: 'default', limit: 2 })), ['a', 'b']);
  assert.deepEqual(getNodes(nodes, 'default', { limit: 0 }), {});
  assert.deepEqual(Object.keys(getNodes(nodes, 'default', { offset: 99 })), []);
});

test('GRAPH BOUNDS: query supports limit/offset and the object scope form', () => {
  const nodes = nodeFixtures();
  assert.equal(query(nodes, 'L', 'default').length, 3);
  assert.equal(query(nodes, 'L', 'default', { limit: 2 }).length, 2);
  assert.equal(query(nodes, 'L', 'default', { limit: 1, offset: 2 })[0].id, 'c');
  assert.equal(query(nodes, 'L', { workspaceId: 'default', limit: 1 }).length, 1);
});

test('GRAPH BOUNDS: edge reads support limit/offset', () => {
  const { edges, outIndex, inIndex } = edgeFixtures();
  assert.equal(getEdges(outIndex, 'a', 'default').length, 3);
  assert.equal(getEdges(outIndex, 'a', 'default', { limit: 2 }).length, 2);
  assert.equal(getEdges(outIndex, 'a', 'default', { limit: 1, offset: 2 })[0].to, 'd');
  assert.equal(getInEdges(inIndex, 'b', 'default', { limit: 5 }).length, 1);
  assert.equal(getAllEdges(edges, 'default', { limit: 1 }).length, 1);
  assert.equal(getEdgesBetween(outIndex, 'a', 'b', 'default', { limit: 0 }).length, 0);
});

test('GRAPH BOUNDS: clone:false returns frozen views that cannot corrupt canonical records', () => {
  const nodes = nodeFixtures();
  const view = getNodes(nodes, 'default', { clone: false, limit: 1 }).a;
  assert.equal(view.id, 'a');
  assert.throws(() => { view.label = 'mutated'; }, /Cannot assign to read only/);
  view.tags.push('mutated-view');
  assert.deepEqual(nodes.a.tags, ['t']);

  const nodeView = getNode(nodes, 'a', 'default', { clone: false });
  assert.throws(() => { nodeView.id = 'x'; }, /Cannot assign to read only/);
  assert.equal(nodes.a.id, 'a');

  const { outIndex } = edgeFixtures();
  const edgeView = getEdge(outIndex, 'a', 'b', 'r', 'default', { clone: false });
  assert.throws(() => { edgeView.relation = 'mutated'; }, /Cannot assign to read only/);
  edgeView.evidence.push('mutated-view');
  assert.deepEqual(outIndex.get(edgeIndexKey('a', 'default'))[0].evidence, ['e1']);
});

test('GRAPH BOUNDS: default reads still deep-clone (isolation preserved)', () => {
  const nodes = nodeFixtures();
  const copy = getNodes(nodes, 'default', { limit: 1 }).a;
  copy.tags.push('mutated');
  assert.deepEqual(nodes.a.tags, ['t']);
});

test('GRAPH BOUNDS: hasAnyEdge answers without cloning', () => {
  const { outIndex } = edgeFixtures();
  assert.equal(hasAnyEdge(outIndex, 'a', 'b', 'default'), true);
  assert.equal(hasAnyEdge(outIndex, 'a', 'missing', 'default'), false);
  assert.equal(hasAnyEdge(outIndex, 'a', 'b', { workspaceId: 'default' }), true);
});

test('GRAPH BOUNDS: Graph class forwards bounds to the read primitives', () => {
  const Graph = require('../graph');
  const g = new Graph({ memoryPath: ':memory:', useSQLite: false });
  try {
    g.addNode('n1', 'L');
    g.addNode('n2', 'L');
    g.addNode('n3', 'L');
    g.addEdge('n1', 'n2', 'r');
    g.addEdge('n1', 'n3', 'r');

    assert.equal(Object.keys(g.getNodes('default')).length, 3);
    assert.equal(Object.keys(g.getNodes('default', { limit: 2 })).length, 2);
    assert.equal(g.query('L', 'default', { limit: 1 }).length, 1);
    assert.equal(g.getAllEdges('default', { limit: 1 }).length, 1);
    assert.equal(g.getEdges('n1', 'default', { limit: 1 }).length, 1);
    assert.equal(g.getEdgesBetween('n1', 'n2', 'default', { limit: 5 }).length, 1);
    assert.equal(g.hasAnyEdge('n1', 'n2', 'default'), true);
    const frozen = g.getNode('n1', 'default', { clone: false });
    assert.equal(Object.isFrozen(frozen), true);
  } finally {
    g.close();
  }
});
