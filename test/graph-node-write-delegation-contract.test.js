const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { addNode } = require('../lib/graph-node-write');
const { nodeStorageKey } = require('../lib/graph-record-utils');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-node-write.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: addNode is a one-line store delegation', () => {
  assert.equal(
    methodBody(graphSource, 'addNode'),
    'return runNodeWrite(this._nodeWriteStoreApi(), id, label, provenance, opts);',
  );
});

test('GRAPH: node-write delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_nodes|_edges/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: node-write delegate preserves workspace, update, and persistence semantics', () => {
  const nodes = {};
  const persisted = [];
  const store = {
    readPersisted: () => ({ enabled: false, existing: null }),
    get: key => nodes[key],
    set: (key, value) => { nodes[key] = value; },
    persist: value => { persisted.push(value); },
  };

  const created = addNode(store, 'n1', 'first', { source: 'fixture' }, { workspaceId: 'ws-a' });
  assert.deepEqual(created, nodes[nodeStorageKey('n1', 'ws-a')]);
  assert.equal(created.workspaceId, 'ws-a');
  assert.equal(created.provenance.source, 'fixture');
  assert.equal(persisted.length, 0);

  const updated = addNode(store, 'n1', 'second', null, { workspaceId: 'ws-a' });
  assert.equal(updated.label, 'second');
  assert.equal(updated.weight, 0.6);
  assert.deepEqual(updated.provenance, { source: 'fixture' });

  const other = addNode(store, 'n1', 'other', null, { workspaceId: 'ws-b' });
  assert.equal(other.workspaceId, 'ws-b');
  assert.notEqual(other, updated);
});

test('GRAPH: addNode persists the reinforced weight instead of a fixed baseline (#1241)', () => {
  const nodes = {};
  const persisted = [];
  let persistedRow = null;
  const store = {
    readPersisted: () => ({ enabled: true, existing: persistedRow }),
    get: key => nodes[key],
    set: (key, value) => { nodes[key] = value; },
    persist: value => {
      persisted.push(value);
      persistedRow = {
        ...value,
        created_at: value.createdAt,
        provenance: value.provenance,
        vector: value.vector,
      };
    },
  };

  addNode(store, 'n1', 'first', null, { workspaceId: 'ws-a' });
  addNode(store, 'n1', 'second', null, { workspaceId: 'ws-a' });

  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].weight, 0.5);
  assert.equal(persisted[1].weight, 0.6);
  assert.equal(nodes[nodeStorageKey('n1', 'ws-a')].weight, 0.6);
});
