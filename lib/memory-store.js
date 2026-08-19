'use strict';

const {
  validateMemoryRecord,
  validateMemoryEvent,
  validateMemoryLink,
  normalizeMemoryRecord,
  normalizeMemoryEvent,
  normalizeMemoryLink,
  MEMORY_STATUSES,
  // PR-S5
  MEMORY_SCHEMA_VERSIONS,
} = require('./memory-schema');

// PR-S3B: Bounded SQLite busy/lock retry with exponential backoff (sync).
const {
  toStableString,
  isValidIsoDate,
  makeProvenance,
  getContentHash,
  resolveDbPath,
  generateMemoryId,
  generateLinkId,
  generateDeterministicLinkId,
  generateEventId,
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
const { snapshotInMemoryState, restoreInMemoryState } = require('./memory-store-rollback');
// #328 MS: query/sort/pagination delegated to memory-query-engine.js; class
// methods are one-line delegations (context interface documented there).
const { runQuery } = require('./memory-query-engine');
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
const { runEventsForMemory, runTimeline } = require('./memory-event-read');
// #328 MS: patchMetadata payload construction/validation delegates to
// memory-patch-metadata.js; the class retains persistence and store-owned state.
const { runPatchMetadata } = require('./memory-patch-metadata');
// #328 MS: tombstone payload construction/validation delegates to memory-tombstone.js;
// the class retains persistence and store-owned state mutation.
const { runTombstone } = require('./memory-tombstone');
// #328 MS: package export delegates read-only collection projection and
// validation to memory-package-export.js.
const { runExportPackage } = require('./memory-package-export');
const { loadSqliteDriver, sqliteUnavailableError } = require('./sqlite-availability');
const { Database, loadError: sqliteLoadError } = loadSqliteDriver();

const {
  sortByCreatedAtThenId,
  sortByLinkSignature,
  sortByEventSignature,
  deepClone,
  cloneMemoryRecord,
  cloneMemoryEvent,
  cloneMemoryLink,
} = require('./memory-record-utils');


class MemoryStore {
  constructor(opts = {}) {
    this._memories = new Map();   // workspaceId:memoryId -> record
    this._events = [];            // append-only event log
    this._links = [];             // memory links
    this._defaultTrustPolicyVersion = opts.trustPolicyVersion || '1.0.0';

    const memoryPath = typeof opts.memoryStorePath === 'string' && opts.memoryStorePath.trim()
      ? opts.memoryStorePath.trim()
      : opts.memoryPath;
    const dbPath = typeof opts.memoryStoreDbPath === 'string' && opts.memoryStoreDbPath.trim()
      ? opts.memoryStoreDbPath.trim()
      : opts.dbPath;
    const useSQLite = opts.memoryStoreUseSQLite !== undefined ? opts.memoryStoreUseSQLite : opts.useSQLite;
    const wantSQLite = useSQLite === true && Database !== null;
    this._db = null;
    this._stmts = null;

    if (useSQLite && !Database) {
      throw sqliteUnavailableError('better-sqlite3 is required for SQLite memory storage.', sqliteLoadError);
    }

    // PR-S3B: bounded busy/lock retry config (sync, fail predictably).
    this._busyRetryConfig = resolveBusyRetryConfig(opts.busyRetry || {});

    if (wantSQLite) {
      this.dbPath = resolveDbPath({ dbPath, memoryPath });
      this._db = new Database(this.dbPath);
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('synchronous = NORMAL');
      // PR-S3B: short, bounded busy_timeout so the lock holder gets a small
      // window but a single transaction can never hang indefinitely.
      this._db.pragma(`busy_timeout = ${this._busyRetryConfig.busyTimeoutMs}`);
      this._initDB();
      this._warmup();
    }
  }

  /**
   * Run a function inside a SQLite transaction if persistence is enabled.
   * In in-memory mode, executes the function directly (no DB lock acquired).
   *
   * Sync; PR-S3B wraps the SQLite branch in a bounded busy/locked retry
   * (runWithBusyRetry) so a short lock contention never turns into a hang.
   * The in-memory branch keeps snapshot/restore semantics unchanged.
   * @param {function} fn
   * @returns {*}
   */
  _withTransaction(fn) {
    if (this._db) {
      return runWithBusyRetry(
        () => this._db.transaction(fn)(),
        Object.assign({}, this._busyRetryConfig, { label: '_withTransaction' })
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
   * Snapshot/restore the in-memory mirror around a transaction. Taken on every
   * backend: a SQLite rollback covers the rows, not this object (#761).
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
   * Build a structured PERSISTENCE_ERROR response.
   * @param {string} operation
   * @param {Error} err
   * @returns {{ ok: false, error: object }}
   */
  _persistenceError(operation, err) {
    return {
      ok: false,
      error: {
        code: 'PERSISTENCE_ERROR',
        operation,
        message: err && err.message ? err.message : String(err),
      },
    };
  }

  _makeMemoryKey(workspaceId, memoryId) {
    const wid = normalizeWorkspaceId(workspaceId);
    const mid = String(memoryId || '').trim();
    return `${wid}:${mid}`;
  }

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

  _temporalReadContext() {
    return { memories: this._memories };
  }

  _linkWriteStoreApi() {
    const store = this;
    return {
      findMemory: (memoryId, workspaceId) => store._findMemory(memoryId, workspaceId),
      findLink: (linkId, workspaceId) => store._links.find((link) => link.linkId === linkId && link.workspaceId === workspaceId),
      defaultTrustPolicyVersion: store._defaultTrustPolicyVersion,
      persist: (opts, payload) => {
        if (!store._db) return;
        const { link, event } = payload;
        const snapshot = store._snapshotInMemoryState();
        try {
          store._withTransaction(() => {
            store._stmts.insertLink.run({
              workspace_id: link.workspaceId,
              link_id: link.linkId,
              relation: link.relation,
              from_memory_id: link.fromMemoryId,
              to_memory_id: link.toMemoryId,
              confidence: link.strength,
              provenance_json: JSON.stringify(link.provenance),
              trust_policy_version: link.trustPolicyVersion,
              created_at: link.createdAt,
            });

            store._stmts.insertEvent.run({
              workspace_id: event.workspaceId,
              event_id: event.eventId,
              event_type: event.eventType,
              memory_id: event.memoryId,
              actor: event.actor,
              details_json: JSON.stringify(event.details),
              provenance_json: JSON.stringify(event.provenance),
              trust_policy_version: event.trustPolicyVersion,
              created_at: event.createdAt,
            });
          });
        } catch (err) {
          store._restoreInMemoryState(snapshot);
          return store._persistenceError('linkMemories', err);
        }
        return undefined;
      },
      appendLink: (link) => { store._links.push(link); },
      appendEvent: (event) => { store._events.push(event); },
    };
  }

  _initDB() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        workspace_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        trust_policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        deleted_at TEXT,
        supersedes_memory_id TEXT,
        PRIMARY KEY (workspace_id, memory_id)
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        details_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        trust_policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_id)
      );

      CREATE TABLE IF NOT EXISTS memory_links (
        workspace_id TEXT NOT NULL,
        link_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        confidence REAL,
        provenance_json TEXT NOT NULL,
        trust_policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, link_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memories_workspace_created ON memories(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace_status ON memories(workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_memory_events_workspace_id_created ON memory_events(workspace_id, memory_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(workspace_id, from_memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(workspace_id, to_memory_id);
    `);

    this._stmts = {
      upsertMemory: this._db.prepare(`
        INSERT INTO memories (
          workspace_id, memory_id, kind, content_json, content_hash, status,
          metadata_json, provenance_json, trust_policy_version, created_at,
          updated_at, deleted_at, supersedes_memory_id
        ) VALUES (
          @workspace_id, @memory_id, @kind, @content_json, @content_hash, @status,
          @metadata_json, @provenance_json, @trust_policy_version, @created_at,
          @updated_at, @deleted_at, @supersedes_memory_id
        )
        ON CONFLICT(workspace_id, memory_id) DO UPDATE SET
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `),
      insertEvent: this._db.prepare(`
        INSERT INTO memory_events (
          workspace_id, event_id, event_type, memory_id, actor, details_json,
          provenance_json, trust_policy_version, created_at
        ) VALUES (
          @workspace_id, @event_id, @event_type, @memory_id, @actor, @details_json,
          @provenance_json, @trust_policy_version, @created_at
        )
      `),
      insertLink: this._db.prepare(`
        INSERT INTO memory_links (
          workspace_id, link_id, relation, from_memory_id, to_memory_id, confidence,
          provenance_json, trust_policy_version, created_at
        ) VALUES (
          @workspace_id, @link_id, @relation, @from_memory_id, @to_memory_id, @confidence,
          @provenance_json, @trust_policy_version, @created_at
        )
      `),
      allMemories: this._db.prepare(`SELECT * FROM memories`),
      allEvents: this._db.prepare(`SELECT * FROM memory_events`),
      allLinks: this._db.prepare(`SELECT * FROM memory_links`),
    };
  }

  _warmup() {
    try {
      const memories = this._stmts.allMemories.all();
      const events = this._stmts.allEvents.all();
      const links = this._stmts.allLinks.all();

      for (const row of memories) {
        const record = normalizeMemoryRecord({
          memoryId: row.memory_id,
          workspaceId: row.workspace_id,
          content: JSON.parse(row.content_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at || undefined,
          deletedAt: row.deleted_at || undefined,
          supersedesMemoryId: row.supersedes_memory_id || undefined,
          status: row.status,
          metadata: JSON.parse(row.metadata_json),
          provenance: JSON.parse(row.provenance_json),
          trustPolicyVersion: row.trust_policy_version,
        });

        const validation = validateMemoryRecord(record);
        if (!validation.ok) {
          throw new Error(`Corrupt memory record found in SQLite during warmup: ${row.memory_id}. Validation errors: ${JSON.stringify(validation.errors)}`);
        }

        Object.freeze(record.content);
        this._memories.set(this._makeMemoryKey(row.workspace_id, row.memory_id), record);
      }

      for (const row of events) {
        const event = {
          eventId: row.event_id,
          eventType: row.event_type,
          memoryId: row.memory_id,
          workspaceId: row.workspace_id,
          createdAt: row.created_at,
          actor: row.actor,
          provenance: JSON.parse(row.provenance_json),
          trustPolicyVersion: row.trust_policy_version,
          details: JSON.parse(row.details_json),
        };
        const validation = validateMemoryEvent(event);
        if (!validation.ok) {
          throw new Error(`Corrupt memory event found in SQLite during warmup: ${row.event_id}. Validation errors: ${JSON.stringify(validation.errors)}`);
        }
        this._events.push(event);
      }

      for (const row of links) {
        const link = {
          linkId: row.link_id,
          relation: row.relation,
          fromMemoryId: row.from_memory_id,
          toMemoryId: row.to_memory_id,
          workspaceId: row.workspace_id,
          createdAt: row.created_at,
          provenance: JSON.parse(row.provenance_json),
          trustPolicyVersion: row.trust_policy_version,
          strength: row.confidence !== null ? row.confidence : undefined,
        };
        const validation = validateMemoryLink(link);
        if (!validation.ok) {
          throw new Error(`Corrupt memory link found in SQLite during warmup: ${row.link_id}. Validation errors: ${JSON.stringify(validation.errors)}`);
        }
        this._links.push(link);
      }
    } catch (e) {
      throw e;
    }
  }

  /**
   * Store a new memory record.
   * @param {object} input - { content, workspaceId?, metadata?, actor?, trustPolicyVersion?, provenance? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  store(input = {}) {
    if (!input || typeof input !== 'object') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'input must be an object' } };
    }
    if (input.content === undefined || input.content === null) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'content is required' } };
    }
    if (typeof input.content === 'string' && input.content.trim() === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'content must not be empty or whitespace' } };
    }

    const now = new Date().toISOString();
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const trustPolicyVersion = input.trustPolicyVersion || this._defaultTrustPolicyVersion;
    const actor = input.actor || 'system';
    const provenance = input.provenance || makeProvenance(actor, workspaceId, trustPolicyVersion);
    const memoryId = generateMemoryId(input.content, workspaceId, now);

    const record = normalizeMemoryRecord({
      memoryId,
      workspaceId,
      content: JSON.parse(JSON.stringify(input.content)),
      createdAt: now,
      provenance,
      trustPolicyVersion,
      status: 'active',
      metadata: input.metadata || {},
    });
    // PR-S5: stamp schemaVersion on every freshly written record.
    record.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryRecord;

    const validation = validateMemoryRecord(record);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'memory record failed validation', details: validation.errors } };
    }

    const event = {
      eventId: generateEventId(),
      eventType: 'CREATED',
      memoryId,
      workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'store' },
    };
    // PR-S5: stamp schemaVersion on every freshly written event.
    event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

    if (this._db) {
      const snapshot = this._snapshotInMemoryState();
      try {
        this._withTransaction(() => {
          this._stmts.upsertMemory.run({
            workspace_id: record.workspaceId,
            memory_id: record.memoryId,
            kind: 'memory-record',
            content_json: JSON.stringify(record.content),
            content_hash: getContentHash(record.content),
            status: record.status,
            metadata_json: JSON.stringify(record.metadata),
            provenance_json: JSON.stringify(record.provenance),
            trust_policy_version: record.trustPolicyVersion,
            created_at: record.createdAt,
            updated_at: record.updatedAt || null,
            deleted_at: record.deletedAt || null,
            supersedes_memory_id: record.supersedesMemoryId || null,
          });

          this._stmts.insertEvent.run({
            workspace_id: event.workspaceId,
            event_id: event.eventId,
            event_type: event.eventType,
            memory_id: event.memoryId,
            actor: event.actor,
            details_json: JSON.stringify(event.details),
            provenance_json: JSON.stringify(event.provenance),
            trust_policy_version: event.trustPolicyVersion,
            created_at: event.createdAt,
          });
        });
      } catch (err) {
        this._restoreInMemoryState(snapshot);
        return this._persistenceError('store', err);
      }
    }

    // Freeze content to enforce immutability
    Object.freeze(record.content);
    this._memories.set(this._makeMemoryKey(workspaceId, memoryId), record);
    this._events.push(event);

    return { ok: true, memory: cloneMemoryRecord(record), event: cloneMemoryEvent(event) };
  }

  /**
   * List memories for a workspace.
   * @param {object} opts - { workspaceId?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, memories: object[], total: number }}
   */
  list(opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : Infinity;
    const offset = typeof opts.offset === 'number' && opts.offset >= 0 ? opts.offset : 0;

    let results = [];
    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && !this._isActiveRecord(record)) continue;
      results.push(record);
    }

    // Deterministic order: by createdAt ascending, then memoryId ascending
    results.sort((a, b) => {
      const t = a.createdAt.localeCompare(b.createdAt);
      return t !== 0 ? t : a.memoryId.localeCompare(b.memoryId);
    });

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return { ok: true, memories: results.map(cloneMemoryRecord), total };
  }

  /**
   * Get a single memory by id.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId? }
   * @returns {{ ok: boolean, memory?: object, error?: object }}
   */
  get(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const wid = normalizeWorkspaceId(opts.workspaceId);
    const record = this._findMemory(memoryId, wid);
    if (!record) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
    }

    if (wid && record.workspaceId !== wid) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
    }

    return { ok: true, memory: cloneMemoryRecord(record) };
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
      persist: (_opts, payload) => {
        if (!store._db) return;
        const { record, event, nextMetadata, now } = payload;
        const snapshot = store._snapshotInMemoryState();
        try {
          store._withTransaction(() => {
            store._stmts.upsertMemory.run({
              workspace_id: record.workspaceId,
              memory_id: record.memoryId,
              kind: 'memory-record',
              content_json: JSON.stringify(record.content),
              content_hash: getContentHash(record.content),
              status: record.status,
              metadata_json: JSON.stringify(nextMetadata),
              provenance_json: JSON.stringify(record.provenance),
              trust_policy_version: record.trustPolicyVersion,
              created_at: record.createdAt,
              updated_at: now,
              deleted_at: record.deletedAt || null,
              supersedes_memory_id: record.supersedesMemoryId || null,
            });

            store._stmts.insertEvent.run({
              workspace_id: event.workspaceId,
              event_id: event.eventId,
              event_type: event.eventType,
              memory_id: event.memoryId,
              actor: event.actor,
              details_json: JSON.stringify(event.details),
              provenance_json: JSON.stringify(event.provenance),
              trust_policy_version: event.trustPolicyVersion,
              created_at: event.createdAt,
            });
          });
        } catch (err) {
          store._restoreInMemoryState(snapshot);
          return store._persistenceError('patchMetadata', err);
        }
      },
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
      persist: (_opts, payload) => {
        if (!store._db) return;
        const { record, event, now } = payload;
        const snapshot = store._snapshotInMemoryState();
        try {
          store._withTransaction(() => {
            store._stmts.upsertMemory.run({
              workspace_id: record.workspaceId,
              memory_id: record.memoryId,
              kind: 'memory-record',
              content_json: JSON.stringify(record.content),
              content_hash: getContentHash(record.content),
              status: 'deleted',
              metadata_json: JSON.stringify(record.metadata),
              provenance_json: JSON.stringify(record.provenance),
              trust_policy_version: record.trustPolicyVersion,
              created_at: record.createdAt,
              updated_at: now,
              deleted_at: now,
              supersedes_memory_id: record.supersedesMemoryId || null,
            });

            store._stmts.insertEvent.run({
              workspace_id: event.workspaceId,
              event_id: event.eventId,
              event_type: event.eventType,
              memory_id: event.memoryId,
              actor: event.actor,
              details_json: JSON.stringify(event.details),
              provenance_json: JSON.stringify(event.provenance),
              trust_policy_version: event.trustPolicyVersion,
              created_at: event.createdAt,
            });
          });
        } catch (err) {
          store._restoreInMemoryState(snapshot);
          return store._persistenceError('tombstone', err);
        }
      },
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
      persist: (_opts, ops) => {
        if (!store._db) return;
        const { newRecord, oldRecord, link, event, oldMemoryUpdateEvent, getContentHash } = ops;
        const now = new Date().toISOString();
        const snapshot = store._snapshotInMemoryState();
        try {
          store._withTransaction(() => {
            // 1. Insert new memory record
            store._stmts.upsertMemory.run({
              workspace_id: newRecord.workspaceId,
              memory_id: newRecord.memoryId,
              kind: 'memory-record',
              content_json: JSON.stringify(newRecord.content),
              content_hash: getContentHash(newRecord.content),
              status: newRecord.status,
              metadata_json: JSON.stringify(newRecord.metadata),
              provenance_json: JSON.stringify(newRecord.provenance),
              trust_policy_version: newRecord.trustPolicyVersion,
              created_at: newRecord.createdAt,
              updated_at: newRecord.updatedAt || null,
              deleted_at: newRecord.deletedAt || null,
              supersedes_memory_id: newRecord.supersedesMemoryId || null,
            });

            // 2. Update old memory status to superseded
            store._stmts.upsertMemory.run({
              workspace_id: oldRecord.workspaceId,
              memory_id: oldRecord.memoryId,
              kind: 'memory-record',
              content_json: JSON.stringify(oldRecord.content),
              content_hash: getContentHash(oldRecord.content),
              status: 'superseded',
              metadata_json: JSON.stringify(oldRecord.metadata),
              provenance_json: JSON.stringify(oldRecord.provenance),
              trust_policy_version: oldRecord.trustPolicyVersion,
              created_at: oldRecord.createdAt,
              updated_at: now,
              deleted_at: oldRecord.deletedAt || null,
              supersedes_memory_id: oldRecord.supersedesMemoryId || null,
            });

            // 3. Insert link
            store._stmts.insertLink.run({
              workspace_id: link.workspaceId,
              link_id: link.linkId,
              relation: link.relation,
              from_memory_id: link.fromMemoryId,
              to_memory_id: link.toMemoryId,
              confidence: link.strength,
              provenance_json: JSON.stringify(link.provenance),
              trust_policy_version: link.trustPolicyVersion,
              created_at: link.createdAt,
            });

            // 4. Insert new memory event
            store._stmts.insertEvent.run({
              workspace_id: event.workspaceId,
              event_id: event.eventId,
              event_type: event.eventType,
              memory_id: event.memoryId,
              actor: event.actor,
              details_json: JSON.stringify(event.details),
              provenance_json: JSON.stringify(event.provenance),
              trust_policy_version: event.trustPolicyVersion,
              created_at: event.createdAt,
            });

            // 5. Insert old memory update event
            store._stmts.insertEvent.run({
              workspace_id: oldMemoryUpdateEvent.workspaceId,
              event_id: oldMemoryUpdateEvent.eventId,
              event_type: oldMemoryUpdateEvent.eventType,
              memory_id: oldMemoryUpdateEvent.memoryId,
              actor: oldMemoryUpdateEvent.actor,
              details_json: JSON.stringify(oldMemoryUpdateEvent.details),
              provenance_json: JSON.stringify(oldMemoryUpdateEvent.provenance),
              trust_policy_version: oldMemoryUpdateEvent.trustPolicyVersion,
              created_at: oldMemoryUpdateEvent.createdAt,
            });
          });
        } catch (err) {
          store._restoreInMemoryState(snapshot);
          return store._persistenceError('supersede', err);
        }
        return undefined;
      },
    };
  }

  /**
   * Get all events for a memory.
   * @param {string} memoryId
   * @returns {object[]}
   */
  getEvents(memoryId) {
    if (!memoryId) return [];
    const id = memoryId.trim();
    return this._events
      .filter(e => e.memoryId === id)
      .sort(sortByEventSignature)
      .map(cloneMemoryEvent);
  }

  /**
   * Get all links for a memory.
   * @param {string} memoryId
   * @returns {object[]}
   */
  getLinks(memoryId) {
    return readLinks(this._linkReadContext(), memoryId);
  }

  _queryTemporalMemories(opts = {}) {
    return runTemporalQuery(this._temporalReadContext(), opts);
  }

  findById(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const record = this._findMemory(memoryId, workspaceId);
    if (!record || record.workspaceId !== workspaceId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${workspaceId}` } };
    }
    if (!opts.includeTombstoned && record.status === 'deleted') {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${workspaceId}` } };
    }

    return { ok: true, memory: cloneMemoryRecord(record) };
  }

  findByContentHash(contentHash, opts = {}) {
    const needle = typeof contentHash === 'string' ? contentHash.trim() : '';
    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'contentHash is required' } };
    }
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const memories = [];
    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && !this._isActiveRecord(record)) continue;
      if (getContentHash(record.content) !== needle) continue;
      memories.push(record);
    }
    memories.sort(sortByCreatedAtThenId);
    return { ok: true, memories: memories.map(cloneMemoryRecord), total: memories.length, contentHash: needle };
  }

  findBySourceRef(sourceRef, opts = {}) {
    const needle = typeof sourceRef === 'string' ? sourceRef.trim() : '';
    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'sourceRef is required' } };
    }
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const memories = [];
    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && !this._isActiveRecord(record)) continue;
      if (record.provenance?.sourceRef !== needle) continue;
      memories.push(record);
    }
    memories.sort(sortByCreatedAtThenId);
    return { ok: true, memories: memories.map(cloneMemoryRecord), total: memories.length, sourceRef: needle };
  }

  findByKind(kind, opts = {}) {
    const needle = typeof kind === 'string' ? kind.trim() : '';
    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'kind is required' } };
    }
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const memories = [];
    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && !this._isActiveRecord(record)) continue;
      if ((record.kind || 'memory-record') !== needle) continue;
      memories.push(record);
    }
    memories.sort(sortByCreatedAtThenId);
    return { ok: true, memories: memories.map(cloneMemoryRecord), total: memories.length, kind: needle };
  }

  findByStatus(status, opts = {}) {
    const needle = typeof status === 'string' ? status.trim() : '';
    if (!needle) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'status is required' } };
    }
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const memories = [];
    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (record.status !== needle) continue;
      memories.push(record);
    }
    memories.sort(sortByCreatedAtThenId);
    return { ok: true, memories: memories.map(cloneMemoryRecord), total: memories.length, status: needle };
  }

  findLinks(memoryId, opts = {}) {
    return readFindLinks(this._linkReadContext(), memoryId, opts);
  }

  findLinkedMemories(memoryId, opts = {}) {
    return readFindLinkedMemories(this._linkReadContext(), memoryId, opts);
  }

  history(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const id = memoryId.trim();
    const events = this._events
      .filter((event) => event.workspaceId === workspaceId && (event.memoryId === id || event.relatedMemoryId === id))
      .sort(sortByEventSignature);
    return { ok: true, memoryId: id, workspaceId, events: events.map(cloneMemoryEvent), total: events.length };
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

  save() {
    return { ok: true, skipped: true, backend: this._db ? 'sqlite' : 'memory' };
  }

  load() {
    return {
      ok: true,
      skipped: true,
      loaded: this._memories.size,
      backend: this._db ? 'sqlite' : 'memory',
    };
  }

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
    if (!start || !end) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'start and end dates are required' } };
    }
    if (!isValidIsoDate(start)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for start date' } };
    }
    if (!isValidIsoDate(end)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for end date' } };
    }

    const queryOpts = {
      ...opts,
      createdAfter: start,
      createdBefore: end,
    };
    return this.query(queryOpts);
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
   * @param {object} opts - { targetWorkspaceId?, mode? }
   * @returns {{ ok: boolean, imported?: { memories: number, events: number, links: number }, error?: object }}
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
      withTransaction: (fn) => store._withTransaction(fn),
      persistMemory: (record, contentHash) => {
        if (!store._db) return;
        store._stmts.upsertMemory.run({
          workspace_id: record.workspaceId,
          memory_id: record.memoryId,
          kind: 'memory-record',
          content_json: JSON.stringify(record.content),
          content_hash: contentHash,
          status: record.status,
          metadata_json: JSON.stringify(record.metadata),
          provenance_json: JSON.stringify(record.provenance),
          trust_policy_version: record.trustPolicyVersion,
          created_at: record.createdAt,
          updated_at: record.updatedAt || null,
          deleted_at: record.deletedAt || null,
          supersedes_memory_id: record.supersedesMemoryId || null,
        });
      },
      rememberMemory: (record) => {
        Object.freeze(record.content);
        store._memories.set(store._makeMemoryKey(record.workspaceId, record.memoryId), record);
      },
      importEvents: (events, context) => importPackageEvents(store, events, context),
      importLinks: (links, context) => importPackageLinks(store, links, context),
      persistenceError: (err) => store._persistenceError('importPackage', err),
    };
  }
}

module.exports = MemoryStore;
