'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { countNodes, countEdges } = require('../lib/graph-count-read');
const { createLabelIndex, rebuildLabelIndex } = require('../lib/graph-label-index');
const { readGraphSurfaceSource } = require('./helpers/graph-surface-source');

const graphSource = readGraphSurfaceSource();
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-count-read.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: nodeCount and edgeCount are one-line delegates', () => {
  assert.equal(methodBody(graphSource, 'nodeCount'), 'return runNodeCount(this._nodes, workspaceId, this._labelIndex);');
  assert.equal(methodBody(graphSource, 'edgeCount'), 'return runEdgeCount(this._edges, workspaceId, this._edgeWorkspaceCounts);');
});

test('GRAPH: count-read delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /workspaceNodeCount/);
});

test('GRAPH: count-read delegate preserves total and workspace-scoped counts', () => {
  const nodes = {
    'default-node': { id: 'default-node', workspaceId: 'default', label: 'a' },
    'workspace-a::one': { id: 'one', workspaceId: 'workspace-a', label: 'a' },
    'workspace-a::two': { id: 'two', workspaceId: 'workspace-a', label: 'b' },
  };
  const edges = [
    { from: 'default-node', to: 'default-node', workspaceId: 'default' },
    { from: 'one', to: 'two', workspaceId: 'workspace-a' },
    { from: 'two', to: 'one', workspaceId: 'workspace-a' },
  ];
  const index = createLabelIndex();
  rebuildLabelIndex(index, nodes);

  assert.equal(countNodes(nodes, undefined, index), 3);
  assert.equal(countNodes(nodes, '', index), 3);
  assert.equal(countNodes(nodes, 'workspace-a', index), 2);
  assert.equal(countNodes(nodes, 'missing', index), 0);
  assert.equal(countEdges(edges), 3);
  assert.equal(countEdges(edges, ''), 3);
  assert.equal(countEdges(edges, 'workspace-a'), 2);
  assert.equal(countEdges(edges, 'missing'), 0);
  const edgeCounts = new Map([['default', 1], ['workspace-a', 2]]);
  assert.equal(countEdges(edges, 'workspace-a', edgeCounts), 2);
  assert.equal(countEdges(edges, 'missing', edgeCounts), 0);
  assert.equal(countEdges(edges, undefined, edgeCounts), 3);
});
