'use strict';

// #328 MS / #1864: reopen() lives here so lib/memory-store.js (already over
// the 800-line budget, which must not grow further) does not change size for
// it. The class method is a one-line delegation; the store keeps handle and
// collection ownership, this module only orchestrates the rebuild.
//
// After restore replaces the backing files, the in-memory collections are
// rebuilt from the fresh backend, never merged into the old ones: the previous
// collections are snapshotted aside, cleared, and reloaded. A reload failure
// restores the previous collections and rethrows, so a partially loaded cache
// is never exposed.

const jsonPersistence = require('./memory-store-json-persistence');
const { applySqliteDurability } = require('./sqlite-durability');
const { loadSqliteDriver } = require('./sqlite-availability');

const { Database } = loadSqliteDriver();

function closeHandle(store) {
  if (store._db) {
    try { store._db.close(); } catch (_) { /* already closed underneath us */ }
    store._db = null;
    store._stmts = null;
  }
}

function snapshotCollections(store) {
  return {
    memories: store._memories,
    events: store._events,
    links: store._links,
    corruptRows: store.corruptRows,
  };
}

function restoreCollections(store, snapshot) {
  store._memories = snapshot.memories;
  store._events = snapshot.events;
  store._links = snapshot.links;
  store.corruptRows = snapshot.corruptRows;
}

function clearCollections(store) {
  store._memories = new Map();
  store._events = [];
  store._links = [];
  store.corruptRows = [];
}

function reopenJson(store) {
  const previous = snapshotCollections(store);
  try {
    jsonPersistence.applyJsonMemoryStore(store, jsonPersistence.loadJsonMemoryStore(store._jsonPath));
  } catch (err) {
    restoreCollections(store, previous);
    throw err;
  }
}

function reopenSqlite(store) {
  const previous = snapshotCollections(store);
  clearCollections(store);
  try {
    store._db = new Database(store.dbPath);
    applySqliteDurability(store._db, 'EVIDENCE', { busyTimeoutMs: store._busyRetryConfig.busyTimeoutMs });
    store._initDB();
    store._warmup();
  } catch (err) {
    closeHandle(store);
    restoreCollections(store, previous);
    throw err;
  }
}

/**
 * Reopen the persistence backend after restore replaced the backing files.
 * No-op for handle-less modes (pure in-memory, or SQLite unavailable).
 */
function reopenMemoryStore(store) {
  closeHandle(store);
  if (store._jsonPath) return reopenJson(store);
  if (!store.dbPath || !Database) return;
  reopenSqlite(store);
}

module.exports = { reopenMemoryStore };
