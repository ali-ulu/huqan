const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { addEdge } = require('../lib/graph-edge-write');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-edge-write.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: addEdge is a one-line store delegation', () => {
  assert.equal(
    methodBody(graphSource, 'addEdge'),
    'return runEdgeWrite(this._edgeWriteStoreApi(), fromId, toId, relation, opts);',
  );
});

test('GRAPH: edge-write delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges|_outIndex|_inIndex/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: edge-write delegate preserves create/update and causal validation semantics', () => {
  const nodes = new Set(['from', 'to']);
  const edges = [];
  const persisted = { creates: [], updates: [], touches: [], nodeTouches: [] };
  const store = {
    hasNode: (id) => nodes.has(id),
    touchNode: (id, workspaceId) => persisted.nodeTouches.push([id, workspaceId]),
    findExisting: (fromId, toId, relation, workspaceId) => edges.find(edge => (
      edge.from === fromId && edge.to === toId && edge.relation === relation
        && edge.workspaceId === workspaceId
    )) || null,
    append: edge => edges.push(edge),
    persistUpdate: (...args) => persisted.updates.push(args),
    persistCreate: (...args) => persisted.creates.push(args),
    recordTouch: (...args) => persisted.touches.push(args),
  };

  const created = addEdge(store, 'from', 'to', 'related_to', {
    workspaceId: 'ws-a',
    weight: 0.4,
    confidence: 0.7,
    source: 'fixture',
    evidence: ['e1'],
    meta: { entityResolution: { subject: { canonical: 'from' } } },
  });
  assert.equal(created.workspaceId, 'ws-a');
  assert.equal(created.weight, 0.4);
  assert.equal(created.confidence, 0.7);
  assert.equal(created.source, 'fixture');
  assert.equal(created.meta.entityResolution.subject.canonical, 'from');
  assert.equal(edges.length, 1);
  assert.equal(persisted.creates.length, 1);
  assert.deepEqual(persisted.touches, [['ws-a', 'from', 'related_to', 'to']]);
  assert.deepEqual(persisted.nodeTouches, [['from', 'ws-a'], ['to', 'ws-a']]);

  const updated = addEdge(store, 'from', 'to', 'related_to', {
    workspaceId: 'ws-a',
    evidence: ['e1', 'e2'],
    confidence: 0.2,
  });
  assert.equal(updated.weight, 0.5);
  assert.equal(updated.confidence, 0.2);
  assert.deepEqual(updated.evidence, ['e1', 'e2']);
  assert.equal(persisted.updates.length, 1);
  assert.equal(persisted.touches.length, 2);

  assert.throws(
    () => addEdge(store, 'from', 'to', 'CAUSES', { workspaceId: 'ws-a' }),
    /requires strength field/,
  );
  assert.equal(persisted.nodeTouches.length, 6);
});

test('GRAPH: edge-write delegate fails closed when an endpoint is absent', () => {
  const calls = [];
  const result = addEdge({
    hasNode: id => id === 'from',
    touchNode: () => calls.push('touch'),
    findExisting: () => { throw new Error('must not inspect edges'); },
    append: () => { throw new Error('must not append'); },
    persistUpdate: () => { throw new Error('must not persist'); },
    persistCreate: () => { throw new Error('must not persist'); },
    recordTouch: () => { throw new Error('must not record'); },
  }, 'from', 'missing', 'related_to');
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});
