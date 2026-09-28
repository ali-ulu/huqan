'use strict';

const { persistenceError } = require('./memory-store-persistence-report');
// #2906: backend selection (SQLite / JSON / memory) lives behind MemoryStorePort.
const { createMemoryStorePort } = require('./memory-store-port');
// #2129: SQLite writes live in memory-store-sqlite-writer.js; the class keeps handle/collection ownership.
const { initMemorySchema, createMemoryStmts, openMemoryDatabase } = require('./memory-store-sqlite-writer');

// PR-S3B: Bounded SQLite busy/lock retry with exponential backoff (sync).
const {
  normalizeWorkspaceId,
  resolveBusyRetryConfig,
  runWithBusyRetry,
} = require('./memory-store-utils');

const { snapshotInMemoryState, restoreInMemoryState } = require('./memory-store-rollback');
// #328 MS: reopen orchestration delegates to memory-store-reopen.js; the
// class retains handle and collection ownership.
const { reopenMemoryStore } = require('./memory-store-reopen');
const { warmup: warmupSQLite } = require('./memory-store-sqlite-warmup');
// #2120: the read/write method groups live in the sibling method modules and
// are installed on MemoryStore.prototype below; their delegate requires moved
// with them, so this entry only keeps lifecycle ownership.
const { install: installReadMethods } = require('./memory-store-read-methods');
const { install: installWriteMethods } = require('./memory-store-write-methods');

class MemoryStore {
  constructor(opts = {}) {
    this._memories = new Map();   // workspaceId:memoryId -> record
    this._events = [];            // append-only event log
    this._links = [];             // memory links
    this.corruptRows = [];
    this._strictWarmup = opts.strictWarmup === true;
    this._defaultTrustPolicyVersion = opts.trustPolicyVersion || '1.0.0';

    const memoryPath = typeof opts.memoryStorePath === 'string' && opts.memoryStorePath.trim()
      ? opts.memoryStorePath.trim()
      : opts.memoryPath;
    const dbPath = typeof opts.memoryStoreDbPath === 'string' && opts.memoryStoreDbPath.trim()
      ? opts.memoryStoreDbPath.trim()
      : opts.dbPath;
    const useSQLite = opts.memoryStoreUseSQLite !== undefined ? opts.memoryStoreUseSQLite : opts.useSQLite;
    this._jsonPath = useSQLite === false && typeof memoryPath === 'string' && memoryPath.trim() ? memoryPath.trim() : null; this._db = null;
    this._stmts = null;
    this._storePort = createMemoryStorePort(this);

    // PR-S3B: bounded busy/lock retry config (sync, fail predictably).
    this._busyRetryConfig = resolveBusyRetryConfig(opts.busyRetry || {});

    // #2129: opening the SQLite handle lives in the writer; the throw for a
    // requested-but-missing driver and the strict-true open rule are unchanged.
    const opened = openMemoryDatabase({
      useSQLite, dbPath, memoryPath,
      busyTimeoutMs: this._busyRetryConfig.busyTimeoutMs,
    });
    if (opened) {
      this.dbPath = opened.dbPath;
      this._db = opened.db;
      this.initDB();
      this.warmup();
    } else if (this._jsonPath) this._storePort.hydrate();
  }

  /**
   * Run fn inside a SQLite transaction when persistence is enabled, directly
   * in in-memory mode. Sync: PR-S3B wraps the SQLite branch in a bounded
   * busy/locked retry; the in-memory branch keeps snapshot/restore semantics.
   *
   * Public since #2129: the SQLite write delegate and the import runner
   * already document this seam; renamed, not aliased.
   * @param {function} fn
   * @returns {*}
   */
  withTransaction(fn) {
    if (this._db) {
      return runWithBusyRetry(
        () => this._db.transaction(fn)(),
        Object.assign({}, this._busyRetryConfig, { label: 'withTransaction' })
      );
    }
    const snapshot = this._snapshotInMemoryState();
    try {
      return fn();
    } catch (err) {
      this._restoreInMemoryState(snapshot);
      throw err;
    }
  }

  /**
   * Snapshot/restore the in-memory mirror around in-memory transactions. SQLite
   * rollback covers its rows, and write delegates update the mirror only after persistence succeeds (#761).
   * @returns {object}
   */
  _snapshotInMemoryState() {
    return snapshotInMemoryState(this);
  }

  /** @param {object|null} snapshot */
  _restoreInMemoryState(snapshot) {
    restoreInMemoryState(this, snapshot);
  }

  /**
   * Build a structured PERSISTENCE_ERROR response. Public since #2129, same
   * reason as withTransaction. The bare `persistenceError` inside is the
   * imported report builder, not recursion.
   * @param {string} operation
   * @param {Error} err
   * @returns {{ ok: false, error: object }}
   */
  persistenceError(operation, err) {
    return persistenceError(operation, err);
  }

  /** Public memory-key builder (#2348): `<normalized workspace>:<trimmed id>`. */
  makeMemoryKey(workspaceId, memoryId) { return `${normalizeWorkspaceId(workspaceId)}:${String(memoryId || '').trim()}`; }
  _makeMemoryKey(workspaceId, memoryId) { return this.makeMemoryKey(workspaceId, memoryId); }

  _findMemory(memoryId, workspaceId) {
    const mid = String(memoryId || '').trim();
    if (!workspaceId) return undefined;
    const wid = normalizeWorkspaceId(workspaceId);
    return this._memories.get(this._makeMemoryKey(wid, mid));
  }

  _isActiveRecord(record) {
    return !!record && record.status === 'active';
  }

  initDB() {
    initMemorySchema(this._db);
    this._stmts = createMemoryStmts(this._db);
  }

  warmup() {
    return warmupSQLite(this);
  }

  // #2120: read/write facades (list/get/query/..., store/patch/tombstone/...,
  // link/import/export and their context/store-API builders) live in the
  // sibling method modules installed below; this entry keeps construction,
  // the transaction seam, backend lifecycle and the private lookup helpers.

  save() { return this._storePort.save(); }

  load() { return this._storePort.load(); }

  /**
   * Close veritabanı bağlantısı.
   */
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
      this._stmts = null;
    }
  }

  // #328 MS / #1864: reopen orchestration lives in memory-store-reopen.js so
  // this over-budget file does not grow; the store keeps handle ownership.
  reopen() {
    return reopenMemoryStore(this);
  }
}

// #2120: read/write method groups installed with the descriptors they had as
// class members, so the prototype surface is unchanged by the split.
installReadMethods(MemoryStore);
installWriteMethods(MemoryStore);

module.exports = MemoryStore;
