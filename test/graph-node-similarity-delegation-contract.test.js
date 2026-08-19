'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { cosineSimilarity } = require('../lib/graph-node-similarity');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-node-similarity.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: cosineSimilarity is a one-line delegate', () => {
  assert.equal(
    methodBody(graphSource, 'cosineSimilarity'),
    'return runNodeSimilarity((nodeId, scope) => this.getNode(nodeId, scope), aId, bId, workspaceId);',
  );
});

test('GRAPH: node-similarity delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: node-similarity delegate preserves scoped lookup and sparse dimensions', () => {
  const calls = [];
  const nodes = {
    'workspace-a::a': { vector: { x: 1, y: 1 } },
    'workspace-a::b': { vector: { x: 1, z: 1 } },
  };
  const result = cosineSimilarity((id, workspaceId) => {
    calls.push([id, workspaceId]);
    return nodes[`${workspaceId}::${id}`];
  }, 'a', 'b', 'workspace-a');

  assert.ok(Math.abs(result - 0.5) < 1e-12);
  assert.deepEqual(calls, [['a', 'workspace-a'], ['b', 'workspace-a']]);
});

test('GRAPH: node-similarity delegate returns zero for missing or zero-vector nodes', () => {
  assert.equal(cosineSimilarity(() => null, 'missing', 'other', 'workspace-a'), 0);
  assert.equal(cosineSimilarity(() => ({ vector: {} }), 'a', 'b', 'workspace-a'), 0);
});
