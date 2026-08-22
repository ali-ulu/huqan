'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { optimize } = require('../lib/graph-optimize');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-optimize.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: optimize is a one-line delegate', () => {
  assert.equal(methodBody(graphSource, 'optimize'), 'return runGraphOptimize(this._optimizeStoreApi(), workspaceId);');
});

test('GRAPH: optimize delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(["']\.\.\/graph["']\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /normalizeWorkspaceId/);
  assert.match(delegateSource, /persistDeleteNode/);
});

test('GRAPH: optimize preserves scoped decay removal and persistence callbacks', () => {
  const nodes = {
    'default::orphan': { id: 'orphan', workspaceId: 'default', weight: 0.001, lastAccessed: 0 },
    'default::connected': { id: 'connected', workspaceId: 'default', weight: 0.001, lastAccessed: 0 },
    'other::orphan': { id: 'orphan', workspaceId: 'other', weight: 0.001, lastAccessed: 0 },
  };
  const prunedScopes = [];
  const deleted = [];
  const persisted = [];
  const audited = [];
  const storeApi = {
    prune: scope => { prunedScopes.push(scope); return 2; },
    getNodes: () => nodes,
    getEdges: (nodeId, workspaceId) => nodeId === 'connected' && workspaceId === 'default' ? [{ from: nodeId }] : [],
    getInEdges: () => [],
    decayLambda: 0.5,
    deleteNode: id => { deleted.push(id); delete nodes[id]; },
    persistDeleteNode: (id, workspaceId) => persisted.push({ id, workspaceId }),
    auditRemoval: (node, decayedWeight) => audited.push({ id: node.id, decayedWeight }),
  };

  const result = optimize(storeApi, ' default ');
  assert.deepEqual(result, { pruned: 2, removedNodes: 1 });
  assert.deepEqual(prunedScopes, ['default']);
  assert.deepEqual(deleted, ['default::orphan']);
  assert.deepEqual(persisted, [{ id: 'orphan', workspaceId: 'default' }]);
  assert.deepEqual(audited.map(event => event.id), ['orphan']);
  assert.ok(nodes['default::connected']);
  assert.ok(nodes['other::orphan']);
});
