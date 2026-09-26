'use strict';

// Characterization of the GraphStorePort backends (#2906). Each test pins one
// behavior that differs between the JSON and SQLite backends, so routing a call
// to the wrong backend, or dropping a guard the port owns, turns a test red.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const { GRAPH_STORE_PORT_METHODS } = require('../lib/graph-store-port');

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const graphs = [];
  t.after(() => {
    for (const graph of graphs) graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    open(options) {
      const graph = new Graph(options);
      graphs.push(graph);
      return graph;
    },
  };
}

function sqliteOptions(root) {
  return {
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  };
}

function openSqliteOrSkip(t, env) {
  const graph = env.open(sqliteOptions(env.root));
  if (graph.getStats().backend !== 'sqlite') {
    t.skip('better-sqlite3 is unavailable');
    return null;
  }
  return graph;
}

test('GraphStorePort names its contract and reports the backend it routes to', (t) => {
  const env = tempRoot(t, 'huqan-graph-port-contract-');
  const graph = env.open({ memoryPath: path.join(env.root, 'memory.json'), useSQLite: false });

  assert.ok(Object.isFrozen(GRAPH_STORE_PORT_METHODS));
  assert.deepEqual(
    [...GRAPH_STORE_PORT_METHODS].sort(),
    ['backend', 'load', 'restoreEmbeddings', 'save', 'stripEmbeddings', 'writeStrippedState'],
  );
  for (const method of GRAPH_STORE_PORT_METHODS) {
    assert.equal(typeof graph._storePort[method], 'function', `port must implement ${method}`);
  }
  assert.equal(graph._storePort.backend(), 'json');
});

test('GraphStorePort selects the backend per call, following the live SQLite handle', (t) => {
  const env = tempRoot(t, 'huqan-graph-port-select-');
  const graph = openSqliteOrSkip(t, env);
  if (!graph) return;

  assert.equal(graph._storePort.backend(), 'sqlite');
  graph.closeSqlite();
  assert.equal(graph._storePort.backend(), 'json');
  graph.reopen();
  assert.equal(graph._storePort.backend(), 'sqlite');
});

test('JSON backend refuses to overwrite a snapshot that changed on disk', (t) => {
  const env = tempRoot(t, 'huqan-graph-port-json-conflict-');
  const memoryPath = path.join(env.root, 'memory.json');
  const stale = env.open({ memoryPath, useSQLite: false });
  const writer = env.open({ memoryPath, useSQLite: false });

  writer.addNode('first', 'First writer', null, { workspaceId: 'ws' });
  writer.save();

  stale._nodes['ws::second'] = { id: 'second', workspaceId: 'ws', label: 'Stale writer' };
  assert.throws(() => stale.save(), { code: 'GRAPH_JSON_WRITE_CONFLICT' });
  const onDisk = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  assert.ok(onDisk.nodes['ws::first'], 'the first writer survives the rejected save');
  assert.equal(onDisk.nodes['ws::second'], undefined);
});

test('SQLite backend writes without the JSON snapshot conflict check', (t) => {
  const env = tempRoot(t, 'huqan-graph-port-sqlite-noconflict-');
  const graph = openSqliteOrSkip(t, env);
  if (!graph) return;

  graph.addNode('kept', 'Kept', null, { workspaceId: 'ws' });
  // A foreign write to the JSON mirror is not a conflict for the SQLite
  // backend: SQLite is the record authority and the mirror is rewritten.
  fs.writeFileSync(graph.memoryPath, JSON.stringify({ nodes: {}, edges: [] }));
  assert.doesNotThrow(() => graph.save());
  assert.ok(JSON.parse(fs.readFileSync(graph.memoryPath, 'utf8')).nodes['ws::kept']);
});

test('a recorded load error blocks save on both backends before any write', (t) => {
  const env = tempRoot(t, 'huqan-graph-port-load-error-');
  const json = env.open({ memoryPath: path.join(env.root, 'json', 'memory.json'), useSQLite: false });
  const loadError = Object.assign(new Error('prior load failed'), { code: 'TEST_LOAD_ERROR' });

  json._persistenceLoadError = loadError;
  assert.throws(() => json.save(), loadError);
  assert.equal(fs.existsSync(json.memoryPath), false, 'JSON save must not write');

  const sqlite = openSqliteOrSkip(t, env);
  if (!sqlite) return;
  sqlite.addNode('blocked', 'Blocked', null, { workspaceId: 'ws' });
  sqlite._persistenceLoadError = loadError;
  assert.throws(() => sqlite.save(), loadError);
  assert.equal(fs.existsSync(sqlite.memoryPath), false, 'SQLite save must not write the mirror');
});

test('SQLite backend maps read failures to SQLITE_PERSISTENCE_LOAD_FAILED', (t) => {
  const env = tempRoot(t, 'huqan-graph-port-sqlite-load-error-');
  const graph = openSqliteOrSkip(t, env);
  if (!graph) return;

  const cause = new Error('disk read failed');
  graph._stmts = { ...graph._stmts, allNodes: { all() { throw cause; } } };
  assert.throws(() => graph.load(), (error) => {
    assert.equal(error.code, 'SQLITE_PERSISTENCE_LOAD_FAILED');
    assert.equal(error.cause, cause);
    return true;
  });
});

test('SQLite backend falls back to the JSON mirror when the database is empty', (t) => {
  const env = tempRoot(t, 'huqan-graph-port-sqlite-json-fallback-');
  const seed = env.open({ memoryPath: path.join(env.root, 'memory.json'), useSQLite: false });
  seed.addNode('mirrored', 'From JSON', null, { workspaceId: 'ws' });
  seed.save();
  seed.close();

  const graph = openSqliteOrSkip(t, env);
  if (!graph) return;
  graph.load();
  assert.equal(graph.getNode('mirrored', { workspaceId: 'ws' }).label, 'From JSON');
});

test('SQLite save rolls back the whole transaction and keeps in-memory embeddings on a write fault', (t) => {
  const env = tempRoot(t, 'huqan-graph-port-sqlite-rollback-');
  const graph = openSqliteOrSkip(t, env);
  if (!graph) return;

  graph.addNode('a', 'A', null, { workspaceId: 'ws' });
  graph.addNode('b', 'B', null, { workspaceId: 'ws' });
  graph.addEdge('a', 'b', 'relates', { workspaceId: 'ws' });
  assert.equal(graph.edgeCount(), 1);
  graph.save();
  const embedding = new Float64Array([0.25, 0.75]);
  graph.assignEmbedding('ws::a', embedding);

  graph._nodes['ws::a'].label = 'A renamed';
  const fault = new Error('edge write failed');
  graph._stmts = { ...graph._stmts, upsertEdge: { run() { throw fault; } } };
  assert.throws(() => graph.save(), fault);

  assert.deepEqual(Array.from(graph._nodes['ws::a'].embedding), [0.25, 0.75]);
  const reader = env.open(sqliteOptions(env.root));
  reader.load();
  assert.equal(reader.getNode('a', { workspaceId: 'ws' }).label, 'A', 'node rewrite must roll back with the edge fault');
});
