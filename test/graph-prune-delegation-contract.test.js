'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { prune } = require('../lib/graph-prune');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-prune.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: prune is a one-line delegate', () => {
  assert.equal(methodBody(graphSource, 'prune'), 'return runGraphPrune(this._pruneStoreApi(), threshold, workspaceId);');
});

test('GRAPH: prune delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /normalizeWorkspaceId/);
  assert.match(delegateSource, /rebuildIndex/);
  assert.match(delegateSource, /persistPrune/);
});

test('GRAPH: prune delegate preserves scoped filtering, default threshold, rebuild and persistence', () => {
  let edges = [
    { from: 'a', to: 'b', workspaceId: 'default', weight: 0.1 },
    { from: 'a', to: 'c', workspaceId: 'default', weight: 0.8 },
    { from: 'a', to: 'd', workspaceId: 'other', weight: 0.1 },
  ];
  let rebuilds = 0;
  const persisted = [];
  const storeApi = {
    getEdges: () => edges,
    setEdges: nextEdges => { edges = nextEdges; },
    rebuildIndex: () => { rebuilds++; },
    getPruneThreshold: () => 0.3,
    persistPrune: (threshold, scope) => persisted.push({ threshold, scope }),
  };

  assert.equal(prune(storeApi), 1);
  assert.deepEqual(edges.map(edge => `${edge.workspaceId}:${edge.to}`), ['default:c', 'other:d']);
  assert.equal(rebuilds, 1);
  assert.deepEqual(persisted, [{ threshold: 0.3, scope: 'default' }]);

  assert.equal(prune(storeApi, 0.2, ' other '), 1);
  assert.deepEqual(edges.map(edge => `${edge.workspaceId}:${edge.to}`), ['default:c']);
  assert.equal(rebuilds, 2);
  assert.deepEqual(persisted, [
    { threshold: 0.3, scope: 'default' },
    { threshold: 0.2, scope: 'other' },
  ]);
});

test('GRAPH: prune delegate does not persist when no edge is removed', () => {
  let edges = [{ from: 'a', to: 'b', workspaceId: 'default', weight: 0.9 }];
  let rebuilds = 0;
  let persisted = 0;
  const storeApi = {
    getEdges: () => edges,
    setEdges: nextEdges => { edges = nextEdges; },
    rebuildIndex: () => { rebuilds++; },
    getPruneThreshold: () => 0.3,
    persistPrune: () => { persisted++; },
  };

  assert.equal(prune(storeApi, 0.3), 0);
  assert.equal(rebuilds, 1);
  assert.equal(persisted, 0);
  assert.deepEqual(edges, [{ from: 'a', to: 'b', workspaceId: 'default', weight: 0.9 }]);
});
