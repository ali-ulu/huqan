'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { edgeIndexKey } = require('../lib/graph-record-utils');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegatePath = path.join(__dirname, '..', 'lib', 'graph-edge-read.js');
const delegateSource = fs.readFileSync(delegatePath, 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: edge reads are delegated one method at a time', () => {
  const expected = {
    getEdge: 'return runEdgeRead(this._outIndex, fromId, toId, relation, workspaceId);',
    getEdgesBetween: 'return runEdgesBetweenRead(this._outIndex, fromId, toId, workspaceId);',
    hasAnyEdge: 'return runHasAnyEdgeRead(this._outIndex, fromId, toId, workspaceId);',
    getEdges: 'return runEdgesRead(this._outIndex, nodeId, workspaceId);',
    getInEdges: 'return runInEdgesRead(this._inIndex, nodeId, workspaceId);',
    getAllEdges: 'return runAllEdgesRead(this._edges, workspaceId);',
  };
  for (const [methodName, body] of Object.entries(expected)) {
    assert.equal(methodBody(graphSource, methodName), body, `${methodName} must remain a one-line delegation`);
  }
});

test('GRAPH: edge-read delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_outIndex|_inIndex|_edges/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: edge-read delegate preserves workspace filtering and cloning', () => {
  const {
    getEdge,
    getEdgesBetween,
    hasAnyEdge,
    getEdges,
    getInEdges,
    getAllEdges,
  } = require('../lib/graph-edge-read');
  const edge = { from: 'a', to: 'b', relation: 'causes', workspaceId: 'w1', meta: { weight: 1 } };
  const other = { from: 'a', to: 'b', relation: 'causes', workspaceId: 'w2', meta: { weight: 2 } };
  const outIndex = new Map([[edgeIndexKey('a', 'w1'), [edge, other]]]);
  const inIndex = new Map([[edgeIndexKey('b', 'w1'), [edge, other]]]);
  const canonical = { ...edge, evidence: [], confidence_history: [], provenance: undefined };

  assert.deepEqual(getEdge(outIndex, 'a', 'b', 'causes', 'w1'), canonical);
  assert.deepEqual(getEdgesBetween(outIndex, 'a', 'b', 'w1'), [canonical]);
  assert.equal(hasAnyEdge(outIndex, 'a', 'b', 'w1'), true);
  assert.deepEqual(getEdges(outIndex, 'a', 'w1'), [canonical]);
  assert.deepEqual(getInEdges(inIndex, 'b', 'w1'), [canonical]);
  assert.deepEqual(getAllEdges([edge, other], 'w1'), [canonical]);

  const result = getEdge(outIndex, 'a', 'b', 'causes', 'w1');
  result.meta.weight = 99;
  assert.equal(edge.meta.weight, 1);
});
