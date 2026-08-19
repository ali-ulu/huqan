const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { touchNode } = require('../lib/graph-node-touch');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-node-touch.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: touchNode is a one-line store delegation', () => {
  assert.equal(
    methodBody(graphSource, 'touchNode'),
    'return runNodeTouch(this._nodeTouchStoreApi(), id, workspaceId);',
  );
});

test('GRAPH: node-touch delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: node-touch delegate preserves scoped update, persistence, and clone semantics', () => {
  const node = { id: 'alpha', workspaceId: 'workspace-a', lastAccessed: 10, vector: { x: 1 } };
  const persisted = [];
  const result = touchNode({
    get: storageKey => storageKey === 'workspace-a::alpha' ? node : undefined,
    persist: (accessedAt, id, workspaceId) => persisted.push([accessedAt, id, workspaceId]),
  }, 'alpha', 'workspace-a');

  assert.equal(result.id, 'alpha');
  assert.equal(result.workspaceId, 'workspace-a');
  assert.notEqual(result, node);
  assert.ok(result.lastAccessed >= 10);
  assert.equal(node.lastAccessed, result.lastAccessed);
  assert.deepEqual(persisted, [[result.lastAccessed, 'alpha', 'workspace-a']]);
  result.vector.x = 99;
  assert.equal(node.vector.x, 1);
});

test('GRAPH: node-touch delegate fails closed for missing or foreign-workspace nodes', () => {
  const calls = [];
  const store = {
    get: storageKey => storageKey === 'foreign::alpha'
      ? { id: 'alpha', workspaceId: 'other', lastAccessed: 10 }
      : undefined,
    persist: (...args) => calls.push(args),
  };
  assert.equal(touchNode(store, 'alpha', 'foreign'), null);
  assert.equal(touchNode(store, 'missing', 'foreign'), null);
  assert.deepEqual(calls, []);
});
