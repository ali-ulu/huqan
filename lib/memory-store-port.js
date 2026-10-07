'use strict';

// MemoryStorePort (#2906): the one persistence surface MemoryStore and its
// import delegate talk to. Separate from GraphStorePort by design; the two
// share no record type and no contract.
//
// Three backends, chosen per call from the store's live state because close()
// and reopen() swap the SQLite handle at runtime:
//   sqlite: a handle is open; lib/memory-store-sqlite-writer.js writes rows.
//   json:   no handle and a memoryPath; lib/memory-store-json-persistence.js
//           rewrites the whole file atomically per mutation.
//   memory: neither; records live in this process only.
//
// The mutation methods keep the writer's operation names so the facade reads
// the same operation it always did; the port decides which backend runs it.

const jsonPersistence = require('./memory-store-json-persistence');
const writer = require('./memory-store-sqlite-writer');
const { saveResult, loadResult } = require('./memory-store-persistence-report');

const MEMORY_STORE_PORT_METHODS = Object.freeze([
  'backend',
  'hydrate',
  'save',
  'load',
  'persistStoreWrite',
  'persistLinkMemories',
  'persistPatchMetadata',
  'persistTombstone',
  'persistSupersede',
  'persistArchive',
  'persistImportMemory',
  'persistImportEvent',
  'persistImportLink',
  'withImportTransaction',
]);

function backendOf(store) {
  if (store._db) return 'sqlite';
  return store._jsonPath ? 'json' : 'memory';
}

function createMemoryStorePort(store) {
  if (!store || typeof store !== 'object') throw new TypeError('MemoryStorePort requires a MemoryStore instance');

  // SQLite writes run in the writer; every other backend goes to the JSON
  // mutation writer, which is a no-op without a memoryPath (memory backend).
  const mutate = (operation, sqliteWrite) => payload => (
    store._db ? sqliteWrite(store, payload) : jsonPersistence.persistJsonMutation(store, operation, payload)
  );

  return Object.freeze({
    backend: () => backendOf(store),
    hydrate: () => jsonPersistence.applyJsonMemoryStore(store, jsonPersistence.loadJsonMemoryStore(store._jsonPath)),
    save() {
      if (store._db) return saveResult(store._db);
      return store._jsonPath ? jsonPersistence.saveJsonStore(store, saveResult) : saveResult(null);
    },
    load() {
      if (store._db) return loadResult(store._db, null, store._memories.size);
      return store._jsonPath
        ? jsonPersistence.loadJsonStore(store, loadResult)
        : loadResult(null, null, store._memories.size);
    },
    persistStoreWrite: (record, event) => (
      store._db ? writer.persistStoreWrite(store, record, event) : jsonPersistence.persistJsonMutation(store, 'store', { record, event })
    ),
    persistLinkMemories: mutate('linkMemories', writer.persistLinkMemories),
    persistPatchMetadata: mutate('patchMetadata', writer.persistPatchMetadata),
    persistTombstone: mutate('tombstone', writer.persistTombstone),
    persistSupersede: mutate('supersede', writer.persistSupersede),
    persistArchive: mutate('archive', writer.persistArchive),
    // Import rows are written inside withImportTransaction; the JSON and memory
    // backends persist the whole import once, when that transaction ends.
    persistImportMemory: (record, contentHash) => (store._db ? writer.persistImportMemory(store, record, contentHash) : undefined),
    persistImportEvent: event => (store._db ? writer.writeEventRow(store, event) : undefined),
    persistImportLink: link => (store._db ? writer.writeLinkRow(store, link) : undefined),
    withImportTransaction: fn => jsonPersistence.withJsonTransaction(store, fn, callback => store.withTransaction(callback)),
  });
}

module.exports = {
  MEMORY_STORE_PORT_METHODS,
  createMemoryStorePort,
};
