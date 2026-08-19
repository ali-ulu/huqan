const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { removeNode } = require('../lib/graph-node-delete');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-node-delete.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: removeNode is a one-line store delegation', () => {
  assert.equal(
    methodBody(graphSource, 'removeNode'),
    'return runNodeDelete(this._nodeDeleteStoreApi(), id, workspaceId);',
  );
});

test('GRAPH: node-delete delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: node-delete delegate preserves scoped deletion and persistence order', () => {
  const calls = [];
  const store = {
    getNode: (id, workspaceId) => {
      calls.push(['getNode', id, workspaceId]);
      return id === 'alpha' ? { id, workspaceId: 'workspace-a' } : null;
    },
    deleteNode: storageKey => calls.push(['deleteNode', storageKey]),
    removeIncidentEdges: (id, workspaceId) => calls.push(['removeIncidentEdges', id, workspaceId]),
    rebuildIndex: () => calls.push(['rebuildIndex']),
    persistDeleteEdges: (id, workspaceId) => calls.push(['persistDeleteEdges', id, workspaceId]),
    persistDeleteNode: (id, workspaceId) => calls.push(['persistDeleteNode', id, workspaceId]),
  };

  assert.equal(removeNode(store, 'alpha', 'workspace-a'), true);
  assert.deepEqual(calls, [
    ['getNode', 'alpha', 'workspace-a'],
    ['deleteNode', 'workspace-a::alpha'],
    ['removeIncidentEdges', 'alpha', 'workspace-a'],
    ['rebuildIndex'],
    ['persistDeleteEdges', 'alpha', 'workspace-a'],
    ['persistDeleteNode', 'alpha', 'workspace-a'],
  ]);
});

test('GRAPH: node-delete delegate fails closed when the node is absent', () => {
  const calls = [];
  const store = {
    getNode: () => null,
    deleteNode: () => calls.push('deleteNode'),
    removeIncidentEdges: () => calls.push('removeIncidentEdges'),
    rebuildIndex: () => calls.push('rebuildIndex'),
    persistDeleteEdges: () => calls.push('persistDeleteEdges'),
    persistDeleteNode: () => calls.push('persistDeleteNode'),
  };
  assert.equal(removeNode(store, 'missing', 'workspace-a'), false);
  assert.deepEqual(calls, []);
});
