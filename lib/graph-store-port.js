'use strict';

const { assertGraphPersistenceWritable } = require('./graph-json-persistence');
const { saveSnapshot, writeCurrentState } = require('./graph-json-snapshot');
const {
  stripEmbeddings,
  restoreEmbeddings,
  writeStrippedState,
  load,
} = require('./graph-persistence-runtime');

function createGraphStorePort(graph, sqlitePersistenceError) {
  if (!graph || typeof graph !== 'object') throw new TypeError('GraphStorePort requires a graph instance');
  if (typeof sqlitePersistenceError !== 'function') {
    throw new TypeError('GraphStorePort requires the SQLite persistence error mapper');
  }

  return Object.freeze({
    stripEmbeddings() {
      return stripEmbeddings(graph);
    },
    restoreEmbeddings(embeddings) {
      return restoreEmbeddings(graph, embeddings);
    },
    save(faultHook) {
      assertGraphPersistenceWritable(graph);
      return graph._db && graph._stmts
        ? writeCurrentState(graph)
        : saveSnapshot(graph, () => writeCurrentState(graph), faultHook);
    },
    writeStrippedState(embeddings) {
      return writeStrippedState(graph, embeddings);
    },
    load() {
      return load(graph, sqlitePersistenceError);
    },
  });
}

module.exports = {
  createGraphStorePort,
};
