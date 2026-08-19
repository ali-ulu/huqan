const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { addTag } = require('../lib/graph-node-tag');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-node-tag.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: addTag is a one-line store delegation', () => {
  assert.equal(
    methodBody(graphSource, 'addTag'),
    'return runNodeTag(this._nodeTagStoreApi(), nodeId, dim, weight, workspaceId);',
  );
});

test('GRAPH: node-tag delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: node-tag delegate preserves new and accumulated dimensions', () => {
  const node = { id: 'alpha', workspaceId: 'workspace-a', vector: {} };
  const store = { get: storageKey => storageKey === 'workspace-a::alpha' ? node : undefined };
  assert.equal(addTag(store, 'alpha', 'mammal', 0.8, 'workspace-a'), undefined);
  assert.equal(node.vector.mammal, 0.8);
  assert.equal(addTag(store, 'alpha', 'mammal', 0.1, 'workspace-a'), undefined);
  assert.equal(node.vector.mammal, 0.9);
});

test('GRAPH: node-tag delegate does not cross workspace boundaries', () => {
  const node = { id: 'alpha', workspaceId: 'workspace-a', vector: {} };
  const store = { get: storageKey => storageKey === 'workspace-a::alpha' ? node : undefined };
  assert.equal(addTag(store, 'alpha', 'mammal', 0.8, 'workspace-b'), undefined);
  assert.deepEqual(node.vector, {});
});
