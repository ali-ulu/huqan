'use strict';

// #3208: SQLite is the source of truth for memory records. This collection
// stands where the full `_memories` Map mirror used to, with the same small
// surface the store and its read/write delegates use (get, set, size, values,
// entries) plus a direct (workspaceId, memoryId) lookup. Only a bounded LRU of
// parsed records stays resident.
//
// Order and visibility match the mirror it replaces: iteration follows rowid
// (the mirror was filled in rowid order and upserts keep a row's rowid), and a
// row that fails validation is never served. Writes still reach SQLite first;
// `set` only caches the record the write path has already persisted (#761).

const { parseMemoryRow } = require('./memory-store-sqlite-row');

const DEFAULT_CACHE_SIZE = 2048;
// Iteration pages through rowids instead of holding an open cursor: callers
// run other statements inside their loops, and better-sqlite3 refuses those
// while an iterator is open on the same connection.
const PAGE_ROWS = 256;

function cacheCapacity(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CACHE_SIZE;
}

class SqliteMemoryCollection {
  constructor(store, { invalidRows = 0, capacity } = {}) {
    this._store = store;
    this._invalidRows = invalidRows;
    this._capacity = cacheCapacity(capacity ?? store._memoryCacheSize);
    this._cache = new Map();
  }

  // SQLite is the only full copy, so a closed store (close(), or a reopen()
  // that failed after restore replaced the file) fails closed instead of
  // answering from whatever part of the data the cache still holds.
  _openStmts() {
    const stmts = this._store._stmts;
    if (stmts) return stmts;
    const error = new Error('memory store is closed; its records live in SQLite (#3208)');
    error.code = 'MEMORY_STORE_CLOSED';
    throw error;
  }

  _remember(key, record) {
    this._cache.delete(key);
    this._cache.set(key, record);
    if (this._cache.size > this._capacity) this._cache.delete(this._cache.keys().next().value);
  }

  /** The record for (workspaceId, memoryId), from the cache or SQLite. */
  lookup(workspaceId, memoryId) {
    const stmts = this._openStmts();
    const key = this._store.makeMemoryKey(workspaceId, memoryId);
    const cached = this._cache.get(key);
    if (cached) {
      this._remember(key, cached);
      return cached;
    }
    const row = stmts.memoryByKey.get(workspaceId, memoryId);
    const record = row && parseMemoryRow(row).record;
    if (!record) return undefined;
    this._remember(key, record);
    return record;
  }

  /**
   * Map-compatible read by composite key. Workspace and memory ids may both
   * contain ':', so every split is tried; the main paths use lookup().
   */
  get(key) {
    this._openStmts();
    const cached = this._cache.get(key);
    if (cached) return cached;
    for (let at = key.indexOf(':'); at !== -1; at = key.indexOf(':', at + 1)) {
      const record = this.lookup(key.slice(0, at), key.slice(at + 1));
      if (record) return record;
    }
    return undefined;
  }

  /**
   * A write path has persisted this record. Drop the cached copy instead of
   * caching the writer's object, so every read sees the row as SQLite returns
   * it -- the same shape a restart would load (e.g. the defaulted
   * schemaVersion), whichever path or cache state serves it.
   */
  set(key) {
    this._cache.delete(key);
    return this;
  }

  get size() {
    return this._openStmts().memoryCount.get().count - this._invalidRows;
  }

  cachedCount() {
    return this._cache.size;
  }

  /** Drop cached records; SQLite is re-read on the next access (rollback). */
  clearCache() {
    this._cache.clear();
  }

  * entries() {
    let afterRowid = Number.MIN_SAFE_INTEGER;
    for (;;) {
      const rows = this._openStmts().memoriesAfterRowid.all(afterRowid, PAGE_ROWS);
      for (const row of rows) {
        // Scans read SQLite, not the cache: writes reach SQLite first, and a
        // scan must not revive a cached record another writer has replaced.
        const record = parseMemoryRow(row).record;
        if (record) yield [this._store.makeMemoryKey(row.workspace_id, row.memory_id), record];
      }
      if (rows.length < PAGE_ROWS) return;
      afterRowid = rows[rows.length - 1].row_id;
    }
  }

  * values() {
    for (const [, record] of this.entries()) yield record;
  }
}

function createSqliteMemoryCollection(store, opts) {
  return new SqliteMemoryCollection(store, opts);
}

module.exports = { DEFAULT_CACHE_SIZE, SqliteMemoryCollection, createSqliteMemoryCollection };
