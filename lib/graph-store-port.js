'use strict';

// GraphStorePort (#2906): the one persistence surface Graph talks to. Two
// in-process backends implement it; RustGraph has its own adapter in
// lib/rust-graph-store-port.js because it persists through the huqan-core
// process or delegates to this port on its JavaScript fallback.
//
// The backend is chosen per call from the live SQLite handle, not once at
// construction: closeSqlite() and reopen() swap the handle at runtime and each
// save/load must follow the handle that exists at that moment.

const { assertGraphPersistenceWritable, loadJsonGraph } = require('./graph-json-persistence');
const { saveSnapshot, writeCurrentState } = require('./graph-json-snapshot');
const {
  stripEmbeddings,
  restoreEmbeddings,
  writeStrippedState,
  loadSqliteGraph,
} = require('./graph-persistence-runtime');

const GRAPH_STORE_PORT_METHODS = Object.freeze([
  'backend',
  'stripEmbeddings',
  'restoreEmbeddings',
  'save',
  'writeStrippedState',
  'load',
]);

// JSON backend: every save runs under the snapshot lock with conflict
// detection and redo recovery; faultHook is the transaction fault seam.
function createJsonGraphStore(graph) {
  return Object.freeze({
    backend: 'json',
    save: faultHook => saveSnapshot(graph, () => writeCurrentState(graph), faultHook),
    load: () => loadJsonGraph(graph),
  });
}

// SQLite backend: SQLite is the record authority, so save writes one SQLite
// transaction plus the JSON mirror without the snapshot conflict check.
function createSqliteGraphStore(graph, sqlitePersistenceError) {
  return Object.freeze({
    backend: 'sqlite',
    save: () => writeCurrentState(graph),
    load: () => loadSqliteGraph(graph, sqlitePersistenceError),
  });
}

function createGraphStorePort(graph, sqlitePersistenceError) {
  if (!graph || typeof graph !== 'object') throw new TypeError('GraphStorePort requires a graph instance');
  if (typeof sqlitePersistenceError !== 'function') {
    throw new TypeError('GraphStorePort requires the SQLite persistence error mapper');
  }

  const json = createJsonGraphStore(graph);
  const sqlite = createSqliteGraphStore(graph, sqlitePersistenceError);
  const select = () => (graph._db && graph._stmts ? sqlite : json);

  return Object.freeze({
    backend() {
      return select().backend;
    },
    stripEmbeddings() {
      return stripEmbeddings(graph);
    },
    restoreEmbeddings(embeddings) {
      return restoreEmbeddings(graph, embeddings);
    },
    save(faultHook) {
      assertGraphPersistenceWritable(graph);
      return select().save(faultHook);
    },
    writeStrippedState(embeddings) {
      return writeStrippedState(graph, embeddings);
    },
    load() {
      return select().load();
    },
  });
}

module.exports = {
  GRAPH_STORE_PORT_METHODS,
  createGraphStorePort,
};
