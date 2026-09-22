'use strict';

const {
  saveResult: persistenceSaveResult,
  loadResult: persistenceLoadResult,
  persistenceError,
} = require('./memory-store-persistence-report');
const jsonPersistence = require('./memory-store-json-persistence');
// #2129: SQLite writes live in memory-store-sqlite-writer.js; the class keeps handle/collection ownership.
const {
  initMemorySchema,
  createMemoryStmts,
  openMemoryDatabase,
  persistStoreWrite,
  persistLinkMemories,
  persistPatchMetadata,
  persistTombstone,
  persistSupersede,
  persistImportMemory,
} = require('./memory-store-sqlite-writer');

// PR-S3B: Bounded SQLite busy/lock retry with exponential backoff (sync).
const {
  normalizeWorkspaceId,
  resolveBusyRetryConfig,
  runWithBusyRetry,
} = require('./memory-store-utils');

// SQLite optional require. The load error is retained (not discarded) so the
// throw site can distinguish "not installed" from "installed but built for a
// different Node ABI" — two failures with different fixes.
const { importPackageEvents, importPackageLinks } = require('./memory-package-import');
// #328 MS: importPackage validation and admission orchestration delegates to
// memory-package-import-runner.js; this class retains transaction/store ownership.
const { runImportPackage } = require('./memory-package-import-runner');
// #328 MS: store input normalization and event construction delegate to
// memory-store-write.js; this class retains persistence and state mutation.
const { runStore } = require('./memory-store-write');
const { snapshotInMemoryState, restoreInMemoryState } = require('./memory-store-rollback');
// #328 MS: reopen orchestration delegates to memory-store-reopen.js; the
// class retains handle and collection ownership.
const { reopenMemoryStore } = require('./memory-store-reopen');
// #328 MS: query/sort/pagination delegated to memory-query-engine.js; class
// methods are one-line delegations (context interface documented there).
const { runQuery, runMemoriesBetween } = require('./memory-query-engine');
// #328 MS: temporal reads delegate to memory-temporal.js through a read-only context.
const { runTemporalQuery } = require('./memory-temporal');
// #328 MS: supersede delegated to memory-supersede.js (store API documented
// in that module); class method is a one-line delegation.
const { runSupersede } = require('./memory-supersede');
// #328 MS: link-read methods delegate to memory-link-read.js; the delegate
// receives a read-only context and has no access to mutation or SQLite state.
const {
  getLinks: readLinks,
  findLinks: readFindLinks,
  findLinkedMemories: readFindLinkedMemories,
  getBacklinks: readBacklinks,
  traverseLinks: readTraverseLinks,
  queryLinks: readQueryLinks,
  linksForMemory: readLinksForMemory,
} = require('./memory-link-read');
// #328 MS: linkMemories delegates payload construction/validation to
// memory-link-write.js; this store API retains SQLite and cache ownership.
const { runLinkMemories } = require('./memory-link-write');
// #328 MS: event reads delegate to memory-event-read.js through a read-only context.
const { runEventsForMemory, runTimeline, runGetEvents, runHistory } = require('./memory-event-read');
// #328 MS: record lookup reads delegate to memory-record-read.js through a read-only context.
const {
  getMemory: readGetMemory,
  listMemories: readListMemories,
  findById: readFindById,
  findByContentHash: readFindByContentHash,
  findBySourceRef: readFindBySourceRef,
  findByKind: readFindByKind,
  findByStatus: readFindByStatus,
} = require('./memory-record-read');
// #328 MS: patchMetadata payload construction/validation delegates to
// memory-patch-metadata.js; the class retains persistence and store-owned state.
const { runPatchMetadata } = require('./memory-patch-metadata');
// #328 MS: tombstone payload construction/validation delegates to memory-tombstone.js;
// the class retains persistence and store-owned state mutation.
const { runTombstone } = require('./memory-tombstone');
// #328 MS: package export delegates read-only collection projection and
// validation to memory-package-export.js.
const { runExportPackage } = require('./memory-package-export');
const { warmup: warmupSQLite } = require('./memory-store-sqlite-warmup');

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
    } else if (this._jsonPath) jsonPersistence.applyJsonMemoryStore(this, jsonPersistence.loadJsonMemoryStore(this._jsonPath));
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

  _linkReadContext() {
    return {
      links: this._links,
      findMemory: (memoryId, workspaceId) => this._findMemory(memoryId, workspaceId),
      isActiveRecord: (record) => this._isActiveRecord(record),
    };
  }

  _eventReadContext() {
    return {
      events: this._events,
      findMemory: (memoryId, workspaceId) => this._findMemory(memoryId, workspaceId),
    };
  }

  _recordReadContext() {
    return {
      memories: this._memories,
      findMemory: (memoryId, workspaceId) => this._findMemory(memoryId, workspaceId),
      isActiveRecord: (record) => this._isActiveRecord(record),
    };
  }

  _temporalReadContext() {
    return { memories: this._memories };
  }

  _linkWriteStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      findLink: (linkId, workspaceId) => store._links.find((link) => link.linkId === linkId && link.workspaceId === workspaceId),
      defaultTrustPolicyVersion: store._defaultTrustPolicyVersion,
      persist: (opts, payload) => persistLinkMemories(store, payload),
      appendLink: (link) => { store._links.push(link); },
      appendEvent: (event) => { store._events.push(event); },
    };
  }

  initDB() {
    initMemorySchema(this._db);
    this._stmts = createMemoryStmts(this._db);
  }

  warmup() {
    return warmupSQLite(this);
  }

  /**
   * Store a new memory record.
   * @param {object} input - { content, workspaceId?, metadata?, actor?, trustPolicyVersion?, provenance? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  store(input = {}) {
    return runStore(this._storeStoreApi(), input);
  }

  // #2129: persist lives in the sqlite writer; the delegate gets this narrow write API.
  _storeStoreApi() {
    const store = this;
    return {
      defaultTrustPolicyVersion: store._defaultTrustPolicyVersion,
      persist: (record, event) => persistStoreWrite(store, record, event),
      remember: (record, event) => {
        Object.freeze(record.content);
        store._memories.set(store._makeMemoryKey(record.workspaceId, record.memoryId), record);
        store._events.push(event);
      },
    };
  }

  /**
   * List memories for a workspace.
   * @param {object} opts - { workspaceId?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, memories: object[], total: number }}
   */
  list(opts = {}) {
    return readListMemories(this._recordReadContext(), opts);
  }

  /**
   * Get a single memory by id.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId? }
   * @returns {{ ok: boolean, memory?: object, error?: object }}
   */
  get(memoryId, opts = {}) {
    return readGetMemory(this._recordReadContext(), memoryId, opts);
  }

  /**
   * Patch mutable metadata only. Cannot change content.
   * @param {string} memoryId
   * @param {object} patch - key/value pairs to merge into metadata
   * @param {object} opts - { actor?, workspaceId? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  patchMetadata(memoryId, patch = {}, opts = {}) {
    return runPatchMetadata(this._patchMetadataStoreApi(), memoryId, patch, opts);
  }

  // #328 MS: persistence remains in MemoryStore; the delegate cannot access
  // SQLite handles or mutate store-owned collections directly.
  _patchMetadataStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      persist: (_opts, payload) => persistPatchMetadata(store, payload),
      applyPatch: (record, nextMetadata, now) => {
        record.metadata = nextMetadata;
        record.updatedAt = now;
      },
      appendEvent: (event) => { store._events.push(event); },
    };
  }

  /**
   * Tombstone a memory. Does not physically delete it.
   * @param {string} memoryId
   * @param {object} opts - { actor?, workspaceId? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  tombstone(memoryId, opts = {}) {
    return runTombstone(this._tombstoneStoreApi(), memoryId, opts);
  }

  // #328 MS: persistence remains in MemoryStore; the delegate cannot access
  // SQLite handles or mutate store-owned collections directly.
  _tombstoneStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      persist: (_opts, payload) => persistTombstone(store, payload),
      markDeleted: (record, now) => {
        record.status = 'deleted';
        record.deletedAt = now;
        record.updatedAt = now;
      },
      appendEvent: (event) => { store._events.push(event); },
    };
  }

  /**
   * Supersede a memory with new content. Creates a new memory and a supersedes link.
   * Old memory is marked as superseded. Content is never overwritten.
   * @param {string} oldMemoryId
   * @param {*} newContent
   * @param {object} opts - { actor?, workspaceId?, metadata?, trustPolicyVersion? }
   * @returns {{ ok: boolean, oldMemory?: object, newMemory?: object, link?: object, event?: object, error?: object }}
   */
  supersede(oldMemoryId, newContent, opts = {}) {
    return runSupersede(this._supersedeStoreApi(), oldMemoryId, newContent, opts);
  }

  // #328 MS: store API exposed to lib/memory-supersede.js. Persistence is
  // transactional with rollback on error (mirrors the original inline block);
  // in-memory updates run only after every validation decision succeeds.
  _supersedeStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      makeKey: (workspaceId, memoryId) => store._makeMemoryKey(workspaceId, memoryId),
      remember: (record, key) => { store._memories.set(key, record); },
      appendLinks: (...links) => { store._links.push(...links); },
      appendEvents: (...events) => { store._events.push(...events); },
      persist: (_opts, ops) => persistSupersede(store, ops),
    };
  }

  /**
   * Get all events for a memory.
   * @param {string} memoryId
   * @param {object} opts
   * @returns {object[]}
   */
  getEvents(memoryId, opts = {}) { return runGetEvents(this._eventReadContext(), memoryId, opts); }

  /**
   * Get all links for a memory in one workspace.
   * @param {string} memoryId
   * @param {object} opts
   * @returns {object[]}
   */
  getLinks(memoryId, opts = {}) { return readLinks(this._linkReadContext(), memoryId, opts); }

  _queryTemporalMemories(opts = {}) {
    return runTemporalQuery(this._temporalReadContext(), opts);
  }

  findById(memoryId, opts = {}) {
    return readFindById(this._recordReadContext(), memoryId, opts);
  }

  findByContentHash(contentHash, opts = {}) {
    return readFindByContentHash(this._recordReadContext(), contentHash, opts);
  }

  findBySourceRef(sourceRef, opts = {}) {
    return readFindBySourceRef(this._recordReadContext(), sourceRef, opts);
  }

  findByKind(kind, opts = {}) {
    return readFindByKind(this._recordReadContext(), kind, opts);
  }

  findByStatus(status, opts = {}) {
    return readFindByStatus(this._recordReadContext(), status, opts);
  }

  findLinks(memoryId, opts = {}) {
    return readFindLinks(this._linkReadContext(), memoryId, opts);
  }

  findLinkedMemories(memoryId, opts = {}) {
    return readFindLinkedMemories(this._linkReadContext(), memoryId, opts);
  }

  history(memoryId, opts = {}) {
    return runHistory(this._eventReadContext(), memoryId, opts);
  }

  link(input = {}) {
    return this.linkMemories(input);
  }

  contradict(memoryId, targetMemoryId, opts = {}) {
    return this.linkMemories({
      fromMemoryId: memoryId,
      toMemoryId: targetMemoryId,
      relation: 'contradicts',
      workspaceId: opts.workspaceId,
      actor: opts.actor,
      trustPolicyVersion: opts.trustPolicyVersion,
      provenance: opts.provenance,
      metadata: opts.metadata,
      confidence: opts.strength,
    });
  }

  getBacklinks(memoryId, opts = {}) {
    return readBacklinks(this._linkReadContext(), memoryId, opts);
  }

  traverseLinks(memoryId, opts = {}) {
    return readTraverseLinks(this._linkReadContext(), memoryId, opts);
  }

  since(timestamp, opts = {}) {
    return this._queryTemporalMemories({ ...opts, since: timestamp });
  }

  before(timestamp, opts = {}) {
    return this._queryTemporalMemories({ ...opts, before: timestamp });
  }

  between(start, end, opts = {}) {
    return this._queryTemporalMemories({ ...opts, between: [start, end] });
  }

  save() { return this._db ? persistenceSaveResult(this._db) : (this._jsonPath ? jsonPersistence.saveJsonStore(this, persistenceSaveResult) : persistenceSaveResult(null)); }

  load() { return this._db ? persistenceLoadResult(this._db, null, this._memories.size) : (this._jsonPath ? jsonPersistence.loadJsonStore(this, persistenceLoadResult) : persistenceLoadResult(null, null, this._memories.size)); }

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

  /**
   * Bellek üzerinde detaylı sorgulama yapar.
   * @param {object} opts Sorgu seçenekleri ve filtreler
   * @returns {{ ok: boolean, memories?: object[], total?: number, limit?: number|null, offset?: number, error?: object }}
   */
  query(opts = {}) {
    return runQuery({ memories: this._memories, isActiveRecord: this._isActiveRecord.bind(this) }, opts);
  }

  /**
   * Bellek sorgulama için temiz alias.
   */
  search(opts = {}) {
    return this.query(opts);
  }

  /**
   * Link two memories together. Idempotent.
   * @param {object} opts - { fromMemoryId, toMemoryId, relation, workspaceId?, confidence?, metadata?, actor?, provenance? }
   * @returns {{ ok: boolean, link?: object, event?: object, error?: object }}
   */
  linkMemories(opts = {}) {
    return runLinkMemories(this._linkWriteStoreApi(), opts);
  }

  /**
   * Query memory links.
   * @param {object} opts - { workspaceId?, fromMemoryId?, toMemoryId?, relation?, includeDeleted?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, links?: object[], total?: number, error?: object }}
   */
  queryLinks(opts = {}) {
    return readQueryLinks(this._linkReadContext(), opts);
  }

  /**
   * Get links for a specific memory.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, direction?, relation?, includeDeleted?, includeTombstoned? }
   * @returns {{ ok: boolean, links?: object[], error?: object }}
   */
  linksForMemory(memoryId, opts = {}) {
    return readLinksForMemory(this._linkReadContext(), memoryId, opts);
  }

  /**
   * Get events for a specific memory.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, eventType?, createdAfter?, createdBefore?, limit?, offset? }
   * @returns {{ ok: boolean, events?: object[], total?: number, error?: object }}
   */
  eventsForMemory(memoryId, opts = {}) {
    return runEventsForMemory(this._eventReadContext(), memoryId, opts);
  }

  /**
   * Get workspace event timeline.
   * @param {object} opts - { workspaceId?, actor?, eventType?, createdAfter?, createdBefore?, limit?, offset? }
   * @returns {{ ok: boolean, events?: object[], total?: number, error?: object }}
   */
  timeline(opts = {}) {
    return runTimeline(this._eventReadContext(), opts);
  }

  /**
   * Get memories created between start and end timestamps.
   * @param {string} start - ISO start timestamp
   * @param {string} end - ISO end timestamp
   * @param {object} opts - { workspaceId?, includeDeleted?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, memories?: object[], total?: number, error?: object }}
   */
  memoriesBetween(start, end, opts = {}) {
    return runMemoriesBetween({ memories: this._memories, isActiveRecord: this._isActiveRecord.bind(this) }, start, end, opts);
  }

  /**
   * Export a memory package for a workspace.
   * @param {object} opts - { workspaceId, includeTombstoned? }
   * @returns {{ ok: boolean, package?: object, error?: object }}
   */
  exportPackage(opts = {}) {
    return runExportPackage({
      memories: this._memories,
      events: this._events,
      links: this._links,
    }, opts);
  }


  /**
   * Import a memory package into a workspace.
   * @param {object} pkg - { version, schemaVersion, workspaceId, memories, events, links }
   * @param {object} opts - { targetWorkspaceId?, workspaceId?, mode? }
   * @returns {{ ok: boolean, targetWorkspaceId?: string, imported?: { memories: number, events: number, links: number }, skipped?: { memories: number, events: number, links: number }, error?: object }}
   */
  importPackage(pkg, opts = {}) {
    return runImportPackage(this._importPackageStoreApi(), pkg, opts);
  }

  // #328 MS: transaction, persistence, and store-owned collections remain here;
  // the delegate receives only this narrow import API.
  _importPackageStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      snapshot: () => store._snapshotInMemoryState(),
      restore: (snapshot) => store._restoreInMemoryState(snapshot),
      withTransaction: fn => jsonPersistence.withJsonTransaction(
        store,
        fn,
        callback => store.withTransaction(callback),
      ),
      persistMemory: (record, contentHash) => persistImportMemory(store, record, contentHash),
      rememberMemory: (record) => {
        Object.freeze(record.content);
        store._memories.set(store._makeMemoryKey(record.workspaceId, record.memoryId), record);
      },
      importEvents: (events, context) => importPackageEvents(store, events, context),
      importLinks: (links, context) => importPackageLinks(store, links, context),
      persistenceError: (err) => store.persistenceError('importPackage', err),
    };
  }
}

module.exports = MemoryStore;
