'use strict';

const {
  validateMemoryRecord,
  validateMemoryEvent,
  validateMemoryLink,
  validateMemoryPackage,
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

// SQLite optional require
let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  Database = null;
}

function sortByCreatedAtThenId(left, right, idField = 'memoryId') {
  const leftTime = typeof left.createdAt === 'string' ? left.createdAt : '';
  const rightTime = typeof right.createdAt === 'string' ? right.createdAt : '';
  const timeComparison = leftTime.localeCompare(rightTime);
  if (timeComparison !== 0) return timeComparison;
  return String(left[idField] || '').localeCompare(String(right[idField] || ''));
}

function sortByLinkSignature(left, right) {
  const workspaceComparison = normalizeWorkspaceId(left.workspaceId).localeCompare(normalizeWorkspaceId(right.workspaceId));
  if (workspaceComparison !== 0) return workspaceComparison;

  const fromComparison = String(left.fromMemoryId || '').localeCompare(String(right.fromMemoryId || ''));
  if (fromComparison !== 0) return fromComparison;

  const toComparison = String(left.toMemoryId || '').localeCompare(String(right.toMemoryId || ''));
  if (toComparison !== 0) return toComparison;

  const relationComparison = String(left.relation || '').localeCompare(String(right.relation || ''));
  if (relationComparison !== 0) return relationComparison;

  const createdComparison = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
  if (createdComparison !== 0) return createdComparison;

  return String(left.linkId || '').localeCompare(String(right.linkId || ''));
}

function sortByEventSignature(left, right) {
  const createdComparison = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
  if (createdComparison !== 0) return createdComparison;
  return String(left.eventId || '').localeCompare(String(right.eventId || ''));
}

function parseTemporalBoundary(value) {
  if (value === undefined || value === null || value === '') return '';
  return isValidIsoDate(value) ? String(value).trim() : '';
}

function readTemporalField(record, field) {
  if (!record || typeof record !== 'object') return '';
  if (field === 'updatedAt') return parseTemporalBoundary(record.updatedAt);
  if (field === 'deletedAt') return parseTemporalBoundary(record.deletedAt);
  if (field === 'accessedAt') return parseTemporalBoundary(record.updatedAt || record.createdAt);
  return parseTemporalBoundary(record.createdAt);
}

function matchesTemporalRange(value, range) {
  if (!value) return false;
  if (range.since && value < range.since) return false;
  if (range.after && value <= range.after) return false;
  if (range.before && value >= range.before) return false;
  if (range.until && value > range.until) return false;
  if (range.start && value < range.start) return false;
  if (range.end && value > range.end) return false;
  return true;
}

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
      throw new Error('better-sqlite3 is required for SQLite memory storage');
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
   * Take a deep snapshot of in-memory state for rollback on failed transaction.
   * Returns null when SQLite persistence is enabled (DB transactions cover rollback).
   * @returns {object|null}
   */
  _snapshotInMemoryState() {
    if (this._db) return null;
    return {
      memories: new Map(
        Array.from(this._memories.entries()).map(([k, v]) => [
          k,
          {
            ...v,
            content: typeof v.content === 'object' && v.content !== null
              ? JSON.parse(JSON.stringify(v.content))
              : v.content,
            metadata: v.metadata ? JSON.parse(JSON.stringify(v.metadata)) : null,
          },
        ])
      ),
      events: this._events.map((e) => ({
        ...e,
        details: e.details ? JSON.parse(JSON.stringify(e.details)) : null,
        provenance: e.provenance ? JSON.parse(JSON.stringify(e.provenance)) : null,
      })),
      links: this._links.map((l) => ({
        ...l,
        provenance: l.provenance ? JSON.parse(JSON.stringify(l.provenance)) : null,
      })),
    };
  }

  /**
   * Restore in-memory state from a snapshot.
   * @param {object|null} snapshot
   */
  _restoreInMemoryState(snapshot) {
    if (!snapshot) return;
    this._memories = snapshot.memories;
    this._events = snapshot.events;
    this._links = snapshot.links;
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
    if (workspaceId) {
      const wid = normalizeWorkspaceId(workspaceId);
      return this._memories.get(this._makeMemoryKey(wid, mid));
    }
    for (const record of this._memories.values()) {
      if (record.memoryId === mid) {
        return record;
      }
    }
    return undefined;
  }

  _isActiveRecord(record) {
    return !!record && record.status === 'active';
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

    return { ok: true, memory: record, event };
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

    return { ok: true, memories: results, total };
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

    const wid = opts.workspaceId ? normalizeWorkspaceId(opts.workspaceId) : null;
    const record = this._findMemory(memoryId, wid);
    if (!record) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
    }

    if (wid && record.workspaceId !== wid) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
    }

    return { ok: true, memory: record };
  }

  /**
   * Patch mutable metadata only. Cannot change content.
   * @param {string} memoryId
   * @param {object} patch - key/value pairs to merge into metadata
   * @param {object} opts - { actor?, workspaceId? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  patchMetadata(memoryId, patch = {}, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'patch must be a plain object' } };
    }

    if (Object.keys(patch).length === 0) {
      return { ok: false, error: { code: 'EMPTY_PATCH', message: 'patch must contain at least one key' } };
    }

    // Guard: cannot overwrite content via metadata patch
    if ('content' in patch) {
      return { ok: false, error: { code: 'IMMUTABLE_CONTENT', message: 'content cannot be changed via patchMetadata; use supersede instead' } };
    }

    // Guard: cannot overwrite status via metadata patch
    if ('status' in patch) {
      return { ok: false, error: { code: 'IMMUTABLE_STATUS', message: 'status cannot be changed via patchMetadata; use tombstone/supersede instead' } };
    }

    const wid = opts.workspaceId ? normalizeWorkspaceId(opts.workspaceId) : null;
    const record = this._findMemory(memoryId, wid);
    if (!record) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
    }

    if (wid && record.workspaceId !== wid) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
    }

    const now = new Date().toISOString();
    const actor = opts.actor || 'system';
    const trustPolicyVersion = opts.trustPolicyVersion || record.trustPolicyVersion;
    const provenance = opts.provenance || makeProvenance(actor, record.workspaceId, trustPolicyVersion);
    const nextMetadata = { ...(record.metadata || {}), ...JSON.parse(JSON.stringify(patch)) };

    const event = {
      eventId: generateEventId(),
      eventType: 'UPDATED',
      memoryId,
      workspaceId: record.workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'patchMetadata', patch },
    };
    // PR-S5
    event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

    const eventValidation = validateMemoryEvent(event);
    if (!eventValidation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'event validation failed', details: eventValidation.errors } };
    }

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
            metadata_json: JSON.stringify(nextMetadata),
            provenance_json: JSON.stringify(record.provenance),
            trust_policy_version: record.trustPolicyVersion,
            created_at: record.createdAt,
            updated_at: now,
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
        return this._persistenceError('patchMetadata', err);
      }
    }

    // Apply mutation to memory in cache
    record.metadata = nextMetadata;
    record.updatedAt = now;
    this._events.push(event);

    return { ok: true, memory: record, event };
  }

  /**
   * Tombstone a memory. Does not physically delete it.
   * @param {string} memoryId
   * @param {object} opts - { actor?, workspaceId? }
   * @returns {{ ok: boolean, memory?: object, event?: object, error?: object }}
   */
  tombstone(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const wid = opts.workspaceId ? normalizeWorkspaceId(opts.workspaceId) : null;
    const record = this._findMemory(memoryId, wid);
    if (!record) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found` } };
    }

    if (wid && record.workspaceId !== wid) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${memoryId} not found in workspace ${wid}` } };
    }

    const now = new Date().toISOString();
    const actor = opts.actor || 'system';
    const trustPolicyVersion = opts.trustPolicyVersion || record.trustPolicyVersion;
    const provenance = opts.provenance || makeProvenance(actor, record.workspaceId, trustPolicyVersion);

    const event = {
      eventId: generateEventId(),
      eventType: 'TOMBSTONE',
      memoryId,
      workspaceId: record.workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'tombstone' },
    };
    // PR-S5
    event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

    const eventValidation = validateMemoryEvent(event);
    if (!eventValidation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'event validation failed', details: eventValidation.errors } };
    }

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
            status: 'deleted',
            metadata_json: JSON.stringify(record.metadata),
            provenance_json: JSON.stringify(record.provenance),
            trust_policy_version: record.trustPolicyVersion,
            created_at: record.createdAt,
            updated_at: now,
            deleted_at: now,
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
        return this._persistenceError('tombstone', err);
      }
    }

    // Apply mutations in-memory cache
    record.status = 'deleted';
    record.deletedAt = now;
    record.updatedAt = now;
    this._events.push(event);

    return { ok: true, memory: record, event };
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
    if (!oldMemoryId || typeof oldMemoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'oldMemoryId is required' } };
    }
    if (newContent === undefined || newContent === null) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'newContent is required' } };
    }

    const wid = opts.workspaceId ? normalizeWorkspaceId(opts.workspaceId) : null;
    const oldRecord = this._findMemory(oldMemoryId, wid);
    if (!oldRecord) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${oldMemoryId} not found` } };
    }

    if (wid && oldRecord.workspaceId !== wid) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${oldMemoryId} not found in workspace ${wid}` } };
    }

    const now = new Date().toISOString();
    const actor = opts.actor || 'system';
    const trustPolicyVersion = opts.trustPolicyVersion || oldRecord.trustPolicyVersion;
    const workspaceId = oldRecord.workspaceId;
    const provenance = opts.provenance || makeProvenance(actor, workspaceId, trustPolicyVersion);
    const newMemoryId = generateMemoryId(newContent, workspaceId, now);

    const newRecord = normalizeMemoryRecord({
      memoryId: newMemoryId,
      workspaceId,
      content: JSON.parse(JSON.stringify(newContent)),
      createdAt: now,
      provenance,
      trustPolicyVersion,
      status: 'active',
      supersedesMemoryId: oldMemoryId,
      metadata: opts.metadata || {},
    });
    // PR-S5
    newRecord.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryRecord;

    const validation = validateMemoryRecord(newRecord);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'new memory record failed validation', details: validation.errors } };
    }

    const link = {
      linkId: generateLinkId(),
      relation: 'supersedes',
      fromMemoryId: newMemoryId,
      toMemoryId: oldMemoryId,
      workspaceId,
      createdAt: now,
      provenance,
      trustPolicyVersion,
      strength: 1.0,
    };
    // PR-S5
    link.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryLink;

    const event = {
      eventId: generateEventId(),
      eventType: 'CREATED',
      memoryId: newMemoryId,
      workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'supersede', supersedesMemoryId: oldMemoryId },
      relatedMemoryId: oldMemoryId,
    };
    // PR-S5
    event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

    const oldPreviousStatus = oldRecord.status || 'active';
    const oldMemoryUpdateEvent = {
      eventId: generateEventId(),
      eventType: 'UPDATED',
      memoryId: oldMemoryId,
      workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: {
        action: 'supersede',
        supersededByMemoryId: newMemoryId,
        previousStatus: oldPreviousStatus,
        newStatus: 'superseded',
      },
    };
    // PR-S5
    oldMemoryUpdateEvent.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

    const eventValidation = validateMemoryEvent(event);
    if (!eventValidation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'event validation failed', details: eventValidation.errors } };
    }

    const oldEventValidation = validateMemoryEvent(oldMemoryUpdateEvent);
    if (!oldEventValidation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'old memory update event validation failed', details: oldEventValidation.errors } };
    }

    if (this._db) {
      const snapshot = this._snapshotInMemoryState();
      try {
        this._withTransaction(() => {
          // 1. Insert new memory record
          this._stmts.upsertMemory.run({
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
          this._stmts.upsertMemory.run({
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
          this._stmts.insertLink.run({
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

          // 5. Insert old memory update event
          this._stmts.insertEvent.run({
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
        this._restoreInMemoryState(snapshot);
        return this._persistenceError('supersede', err);
      }
    }

    // Freeze content and update in-memory cache
    Object.freeze(newRecord.content);
    this._memories.set(this._makeMemoryKey(workspaceId, newMemoryId), newRecord);

    oldRecord.status = 'superseded';
    oldRecord.updatedAt = now;

    this._links.push(link);
    this._events.push(event);
    this._events.push(oldMemoryUpdateEvent);

    return { ok: true, oldMemory: oldRecord, newMemory: newRecord, link, event, oldMemoryUpdateEvent };
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
      .sort(sortByEventSignature);
  }

  /**
   * Get all links for a memory.
   * @param {string} memoryId
   * @returns {object[]}
   */
  getLinks(memoryId) {
    if (!memoryId) return [];
    const id = memoryId.trim();
    return this._links
      .filter(l => l.fromMemoryId === id || l.toMemoryId === id)
      .sort(sortByLinkSignature);
  }

  _queryTemporalMemories(opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const field = typeof opts.field === 'string' && opts.field.trim() ? opts.field.trim() : 'createdAt';
    const allowedFields = ['createdAt', 'updatedAt', 'deletedAt', 'accessedAt'];
    if (!allowedFields.includes(field)) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'field must be createdAt, updatedAt, deletedAt, or accessedAt' } };
    }

    const includeTombstoned = opts.includeTombstoned === true;
    const range = {
      since: parseTemporalBoundary(opts.since),
      after: parseTemporalBoundary(opts.after),
      before: parseTemporalBoundary(opts.before),
      until: parseTemporalBoundary(opts.until),
      start: Array.isArray(opts.between) ? parseTemporalBoundary(opts.between[0]) : parseTemporalBoundary(opts.start),
      end: Array.isArray(opts.between) ? parseTemporalBoundary(opts.between[1]) : parseTemporalBoundary(opts.end),
    };

    const memories = [];
    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && record.status === 'deleted') continue;
      const value = readTemporalField(record, field);
      if (!matchesTemporalRange(value, range)) continue;
      memories.push(record);
    }

    memories.sort((left, right) => sortByCreatedAtThenId(left, right, 'memoryId'));
    return {
      ok: true,
      memories,
      total: memories.length,
      workspaceId,
      field,
      range,
    };
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

    return { ok: true, memory: record };
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
    return { ok: true, memories, total: memories.length, contentHash: needle };
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
    return { ok: true, memories, total: memories.length, sourceRef: needle };
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
    return { ok: true, memories, total: memories.length, kind: needle };
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
    return { ok: true, memories, total: memories.length, status: needle };
  }

  findLinks(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const relation = typeof opts.relation === 'string' ? opts.relation.trim() : '';
    const direction = typeof opts.direction === 'string' ? opts.direction.trim().toLowerCase() : 'both';
    const id = memoryId.trim();
    const links = this.getLinks(id).filter((link) => {
      if (link.workspaceId !== workspaceId) return false;
      if (relation && link.relation !== relation) return false;
      if (direction === 'outgoing') return link.fromMemoryId === id;
      if (direction === 'incoming') return link.toMemoryId === id;
      return link.fromMemoryId === id || link.toMemoryId === id;
    });
    return { ok: true, links, total: links.length, memoryId: id, workspaceId };
  }

  findLinkedMemories(memoryId, opts = {}) {
    const linksResult = this.findLinks(memoryId, opts);
    if (!linksResult.ok) return linksResult;

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const sourceId = memoryId.trim();
    const linkedIds = new Set();
    for (const link of linksResult.links) {
      if (link.fromMemoryId === sourceId) linkedIds.add(link.toMemoryId);
      if (link.toMemoryId === sourceId) linkedIds.add(link.fromMemoryId);
    }

    const memories = [];
    for (const linkedId of linkedIds) {
      const record = this._findMemory(linkedId, workspaceId);
      if (!record || record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && !this._isActiveRecord(record)) continue;
      memories.push(record);
    }
    memories.sort(sortByCreatedAtThenId);

    return {
      ok: true,
      memoryId: sourceId,
      workspaceId,
      links: linksResult.links,
      memories,
      total: memories.length,
    };
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
    return { ok: true, memoryId: id, workspaceId, events, total: events.length };
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
    if (!memoryId || typeof memoryId !== 'string') {
      return [];
    }
    const id = memoryId.trim();
    if (!id) return [];
    return this.getLinks(id).filter((link) => link.toMemoryId === id);
  }

  traverseLinks(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;
    const direction = typeof opts.direction === 'string' ? opts.direction.trim().toLowerCase() : 'both';
    const relation = typeof opts.relation === 'string' ? opts.relation.trim() : '';
    const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth >= 0 ? opts.maxDepth : 1;
    const rootId = memoryId.trim();
    const root = this._findMemory(rootId, workspaceId);
    if (!root || root.workspaceId !== workspaceId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'memory ' + memoryId + ' not found in workspace ' + workspaceId } };
    }
    if (!includeTombstoned && !this._isActiveRecord(root)) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'memory ' + memoryId + ' not found in workspace ' + workspaceId } };
    }

    const visitedNodes = new Set([rootId]);
    const visitedLinks = new Set();
    const nodes = [root];
    const links = [];
    const queue = [{ memoryId: rootId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;
      const currentLinks = this.getLinks(current.memoryId).filter((link) => {
        if (link.workspaceId !== workspaceId) return false;
        if (relation && link.relation !== relation) return false;
        if (direction === 'incoming') return link.toMemoryId === current.memoryId;
        if (direction === 'outgoing') return link.fromMemoryId === current.memoryId;
        return link.fromMemoryId === current.memoryId || link.toMemoryId === current.memoryId;
      });
      for (const link of currentLinks) {
        if (visitedLinks.has(link.linkId)) continue;
        visitedLinks.add(link.linkId);
        links.push(link);
        const neighborId = link.fromMemoryId === current.memoryId ? link.toMemoryId : link.fromMemoryId;
        if (visitedNodes.has(neighborId)) continue;
        const neighbor = this._findMemory(neighborId, workspaceId);
        if (!neighbor || neighbor.workspaceId !== workspaceId) continue;
        if (!includeTombstoned && !this._isActiveRecord(neighbor)) continue;
        visitedNodes.add(neighborId);
        nodes.push(neighbor);
        queue.push({ memoryId: neighborId, depth: current.depth + 1 });
      }
    }

    links.sort(sortByLinkSignature);

    return {
      ok: true,
      memoryId: rootId,
      workspaceId,
      maxDepth,
      nodes,
      links,
      totalNodes: nodes.length,
      totalLinks: links.length,
    };
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
    if (!opts || typeof opts !== 'object') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'options must be an object' } };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    
    // Parse pagination options
    let offset = 0;
    if (opts.offset !== undefined) {
      offset = Number(opts.offset);
      if (isNaN(offset) || offset < 0) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'offset must be a non-negative number' } };
      }
    }

    // Limit rules: default 100, maxLimit 1000
    let limit = 100;
    if (opts.limit !== undefined) {
      if (opts.limit === null) {
        limit = Infinity;
      } else {
        limit = Number(opts.limit);
        if (isNaN(limit) || limit < 0) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit must be a non-negative number or null' } };
        }
        if (limit > 1000) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit exceeds max limit of 1000' } };
        }
      }
    }

    // Date filters validation
    const dateFilters = ['createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore'];
    for (const df of dateFilters) {
      if (opts[df] !== undefined && opts[df] !== null) {
        if (!isValidIsoDate(opts[df])) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid date format for ${df}` } };
        }
      }
    }

    // Filters
    const kind = opts.kind;
    const status = opts.status;
    const actor = opts.actor;
    const sourceType = opts.sourceType;
    const sourceRef = opts.sourceRef;
    const createdAfter = opts.createdAfter ? new Date(opts.createdAfter).getTime() : null;
    const createdBefore = opts.createdBefore ? new Date(opts.createdBefore).getTime() : null;
    const updatedAfter = opts.updatedAfter ? new Date(opts.updatedAfter).getTime() : null;
    const updatedBefore = opts.updatedBefore ? new Date(opts.updatedBefore).getTime() : null;
    
    const contentIncludes = opts.contentIncludes || opts.text;
    const contentIncludesLower = contentIncludes ? String(contentIncludes).toLowerCase() : null;

    const includeDeleted = opts.includeDeleted === true || opts.includeTombstoned === true;

    // Metadata filter - shallow match
    const metadataFilter = opts.metadata;
    if (metadataFilter && (typeof metadataFilter !== 'object' || Array.isArray(metadataFilter))) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'metadata filter must be an object' } };
    }

    let results = [];
    for (const record of this._memories.values()) {
      // 1. Workspace boundary (strictly enforced)
      if (record.workspaceId !== workspaceId) continue;

      // 2. Non-active status
      if (!includeDeleted && status === undefined && !this._isActiveRecord(record)) continue;

      // 3. Kind
      const recordKind = record.kind || 'memory-record';
      if (kind !== undefined && recordKind !== kind) continue;

      // 4. Status
      if (status !== undefined && record.status !== status) continue;

      // 5. Actor
      if (actor !== undefined && record.provenance?.actor !== actor) continue;

      // 6. SourceType
      if (sourceType !== undefined && record.provenance?.sourceType !== sourceType) continue;

      // 7. SourceRef
      if (sourceRef !== undefined && record.provenance?.sourceRef !== sourceRef) continue;

      // 8. Date ranges (inclusive)
      if (record.createdAt) {
        const cat = new Date(record.createdAt).getTime();
        if (createdAfter !== null && cat < createdAfter) continue;
        if (createdBefore !== null && cat > createdBefore) continue;
      }
      if (record.updatedAt) {
        const uat = new Date(record.updatedAt).getTime();
        if (updatedAfter !== null && uat < updatedAfter) continue;
        if (updatedBefore !== null && uat > updatedBefore) continue;
      } else {
        if (updatedAfter !== null || updatedBefore !== null) continue;
      }

      // 9. Content search
      if (contentIncludesLower !== null) {
        const contentStr = toStableString(record.content).toLowerCase();
        if (!contentStr.includes(contentIncludesLower)) continue;
      }

      // 10. Metadata exact match (shallow)
      if (metadataFilter) {
        let match = true;
        const recMeta = record.metadata || {};
        for (const [k, v] of Object.entries(metadataFilter)) {
          if (recMeta[k] !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      results.push(record);
    }

    // Ordering
    const orderBy = opts.orderBy || 'createdAt';
    const order = opts.order || 'asc';

    const validOrderBy = ['createdAt', 'updatedAt', 'memoryId'];
    if (!validOrderBy.includes(orderBy)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid orderBy option: ${orderBy}` } };
    }
    const validOrder = ['asc', 'desc'];
    if (!validOrder.includes(order)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid order option: ${order}` } };
    }

    results.sort((a, b) => {
      let valA = a[orderBy];
      let valB = b[orderBy];

      if (valA === undefined || valA === null) valA = '';
      if (valB === undefined || valB === null) valB = '';

      let comp = 0;
      if (orderBy === 'createdAt' || orderBy === 'updatedAt') {
        comp = valA.localeCompare(valB);
      } else {
        comp = String(valA).localeCompare(String(valB));
      }

      if (comp !== 0) {
        return order === 'asc' ? comp : -comp;
      }

      // Tie-breaker: memoryId asc
      return a.memoryId.localeCompare(b.memoryId);
    });

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
      ok: true,
      memories: results,
      total,
      limit: limit === Infinity ? null : limit,
      offset
    };
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
    if (!opts || typeof opts !== 'object') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'options must be an object' } };
    }
    const fromMemoryId = String(opts.fromMemoryId || '').trim();
    const toMemoryId = String(opts.toMemoryId || '').trim();
    const relation = String(opts.relation || '').trim();
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);

    if (!fromMemoryId || !toMemoryId || !relation) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'fromMemoryId, toMemoryId and relation are required' } };
    }

    const fromMemory = this._findMemory(fromMemoryId, workspaceId);
    const toMemory = this._findMemory(toMemoryId, workspaceId);

    if (!fromMemory || fromMemory.workspaceId !== workspaceId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `source memory ${fromMemoryId} not found in workspace ${workspaceId}` } };
    }
    if (!toMemory || toMemory.workspaceId !== workspaceId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `target memory ${toMemoryId} not found in workspace ${workspaceId}` } };
    }

    if (fromMemory.status === 'deleted' || toMemory.status === 'deleted') {
      return { ok: false, error: { code: 'INVALID_STATE', message: 'cannot link deleted or tombstoned memories' } };
    }

    const validRelations = ['supersedes', 'contradicts', 'supports', 'references', 'related_to'];
    if (!validRelations.includes(relation)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid relation: ${relation}` } };
    }

    const linkId = generateDeterministicLinkId(workspaceId, fromMemoryId, toMemoryId, relation);

    const existingLink = this._links.find(l => l.linkId === linkId && l.workspaceId === workspaceId);
    if (existingLink) {
      return { ok: true, link: existingLink };
    }

    const now = new Date().toISOString();
    const trustPolicyVersion = opts.trustPolicyVersion || this._defaultTrustPolicyVersion;
    const actor = opts.actor || 'system';
    const provenance = opts.provenance || makeProvenance(actor, workspaceId, trustPolicyVersion);

    const link = {
      linkId,
      relation,
      fromMemoryId,
      toMemoryId,
      workspaceId,
      createdAt: now,
      provenance,
      trustPolicyVersion,
      strength: opts.confidence !== undefined ? Number(opts.confidence) : 1.0,
      metadata: opts.metadata || {},
    };
    // PR-S5
    link.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryLink;

    const validation = validateMemoryLink(link);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'link validation failed', details: validation.errors } };
    }

    const event = {
      eventId: generateEventId(),
      eventType: 'LINKED',
      memoryId: fromMemoryId,
      workspaceId,
      createdAt: now,
      actor,
      provenance,
      trustPolicyVersion,
      details: { action: 'linkMemories', relation, toMemoryId, linkId },
    };
    // PR-S5
    event.schemaVersion = MEMORY_SCHEMA_VERSIONS.memoryEvent;

    const eventValidation = validateMemoryEvent(event);
    if (!eventValidation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'linked event validation failed', details: eventValidation.errors } };
    }

    if (this._db) {
      const snapshot = this._snapshotInMemoryState();
      try {
        this._withTransaction(() => {
          this._stmts.insertLink.run({
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
        return this._persistenceError('linkMemories', err);
      }
    }

    this._links.push(link);
    this._events.push(event);

    return { ok: true, link, event };
  }

  /**
   * Query memory links.
   * @param {object} opts - { workspaceId?, fromMemoryId?, toMemoryId?, relation?, includeDeleted?, includeTombstoned?, limit?, offset? }
   * @returns {{ ok: boolean, links?: object[], total?: number, error?: object }}
   */
  queryLinks(opts = {}) {
    if (!opts || typeof opts !== 'object') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'options must be an object' } };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const fromMemoryId = opts.fromMemoryId ? String(opts.fromMemoryId).trim() : null;
    const toMemoryId = opts.toMemoryId ? String(opts.toMemoryId).trim() : null;
    const relation = opts.relation ? String(opts.relation).trim() : null;
    const includeDeleted = opts.includeDeleted === true || opts.includeTombstoned === true;

    if (relation) {
      const validRelations = ['supersedes', 'contradicts', 'supports', 'references', 'related_to'];
      if (!validRelations.includes(relation)) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid relation: ${relation}` } };
      }
    }

    let offset = 0;
    if (opts.offset !== undefined) {
      offset = Number(opts.offset);
      if (isNaN(offset) || offset < 0) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'offset must be a non-negative number' } };
      }
    }

    let limit = 100;
    if (opts.limit !== undefined) {
      if (opts.limit === null) {
        limit = Infinity;
      } else {
        limit = Number(opts.limit);
        if (isNaN(limit) || limit < 0) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit must be a non-negative number or null' } };
        }
        if (limit > 1000) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit exceeds max limit of 1000' } };
        }
      }
    }

    let results = [];
    for (const link of this._links) {
      if (link.workspaceId !== workspaceId) continue;
      if (relation && link.relation !== relation) continue;
      if (fromMemoryId && link.fromMemoryId !== fromMemoryId) continue;
      if (toMemoryId && link.toMemoryId !== toMemoryId) continue;

      const fromMem = this._findMemory(link.fromMemoryId, workspaceId);
      const toMem = this._findMemory(link.toMemoryId, workspaceId);
      if (!fromMem || !toMem) {
        continue;
      }
      if (!includeDeleted && (!this._isActiveRecord(fromMem) || !this._isActiveRecord(toMem))) {
        continue;
      }

      results.push(link);
    }

    results.sort(sortByLinkSignature);

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
      ok: true,
      links: results,
      total,
      limit: limit === Infinity ? null : limit,
      offset
    };
  }

  /**
   * Get links for a specific memory.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, direction?, relation?, includeDeleted?, includeTombstoned? }
   * @returns {{ ok: boolean, links?: object[], error?: object }}
   */
  linksForMemory(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }
    const id = memoryId.trim();
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const direction = opts.direction || 'both';
    const relation = opts.relation ? String(opts.relation).trim() : null;
    const includeDeleted = opts.includeDeleted === true || opts.includeTombstoned === true;

    const validDirections = ['both', 'outgoing', 'incoming'];
    if (!validDirections.includes(direction)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: `invalid direction: ${direction}` } };
    }

    let results = [];
    for (const link of this._links) {
      if (link.workspaceId !== workspaceId) continue;
      if (relation && link.relation !== relation) continue;

      let match = false;
      if (direction === 'both') {
        match = (link.fromMemoryId === id || link.toMemoryId === id);
      } else if (direction === 'outgoing') {
        match = (link.fromMemoryId === id);
      } else if (direction === 'incoming') {
        match = (link.toMemoryId === id);
      }

      if (!match) continue;

      const fromMem = this._findMemory(link.fromMemoryId, workspaceId);
      const toMem = this._findMemory(link.toMemoryId, workspaceId);
      if (!fromMem || !toMem) {
        continue;
      }
      if (!includeDeleted && (!this._isActiveRecord(fromMem) || !this._isActiveRecord(toMem))) {
        continue;
      }

      results.push(link);
    }

    results.sort(sortByLinkSignature);

    return { ok: true, links: results };
  }

  /**
   * Get events for a specific memory.
   * @param {string} memoryId
   * @param {object} opts - { workspaceId?, eventType?, createdAfter?, createdBefore?, limit?, offset? }
   * @returns {{ ok: boolean, events?: object[], total?: number, error?: object }}
   */
  eventsForMemory(memoryId, opts = {}) {
    if (!memoryId || typeof memoryId !== 'string') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'memoryId is required' } };
    }
    const id = memoryId.trim();
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);

    const record = this._findMemory(id, workspaceId);
    if (!record || record.workspaceId !== workspaceId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `memory ${id} not found in workspace ${workspaceId}` } };
    }

    const eventType = opts.eventType;
    const createdAfter = opts.createdAfter ? new Date(opts.createdAfter).getTime() : null;
    const createdBefore = opts.createdBefore ? new Date(opts.createdBefore).getTime() : null;

    if (opts.createdAfter && !isValidIsoDate(opts.createdAfter)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for createdAfter' } };
    }
    if (opts.createdBefore && !isValidIsoDate(opts.createdBefore)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for createdBefore' } };
    }

    let offset = 0;
    if (opts.offset !== undefined) {
      offset = Number(opts.offset);
      if (isNaN(offset) || offset < 0) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'offset must be a non-negative number' } };
      }
    }

    let limit = 100;
    if (opts.limit !== undefined) {
      if (opts.limit === null) {
        limit = Infinity;
      } else {
        limit = Number(opts.limit);
        if (isNaN(limit) || limit < 0) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit must be a non-negative number or null' } };
        }
        if (limit > 1000) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit exceeds max limit of 1000' } };
        }
      }
    }

    let results = [];
    for (const event of this._events) {
      if (event.workspaceId !== workspaceId) continue;
      if (event.memoryId !== id) continue;
      if (eventType && event.eventType !== eventType) continue;

      const t = new Date(event.createdAt).getTime();
      if (createdAfter !== null && t < createdAfter) continue;
      if (createdBefore !== null && t > createdBefore) continue;

      results.push(event);
    }

    results.sort((a, b) => {
      const t = a.createdAt.localeCompare(b.createdAt);
      return t !== 0 ? t : a.eventId.localeCompare(b.eventId);
    });

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
      ok: true,
      events: results,
      total,
      limit: limit === Infinity ? null : limit,
      offset
    };
  }

  /**
   * Get workspace event timeline.
   * @param {object} opts - { workspaceId?, actor?, eventType?, createdAfter?, createdBefore?, limit?, offset? }
   * @returns {{ ok: boolean, events?: object[], total?: number, error?: object }}
   */
  timeline(opts = {}) {
    if (!opts || typeof opts !== 'object') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'options must be an object' } };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const actor = opts.actor;
    const eventType = opts.eventType;
    const createdAfter = opts.createdAfter ? new Date(opts.createdAfter).getTime() : null;
    const createdBefore = opts.createdBefore ? new Date(opts.createdBefore).getTime() : null;

    if (opts.createdAfter && !isValidIsoDate(opts.createdAfter)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for createdAfter' } };
    }
    if (opts.createdBefore && !isValidIsoDate(opts.createdBefore)) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid date format for createdBefore' } };
    }

    let offset = 0;
    if (opts.offset !== undefined) {
      offset = Number(opts.offset);
      if (isNaN(offset) || offset < 0) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'offset must be a non-negative number' } };
      }
    }

    let limit = 100;
    if (opts.limit !== undefined) {
      if (opts.limit === null) {
        limit = Infinity;
      } else {
        limit = Number(opts.limit);
        if (isNaN(limit) || limit < 0) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit must be a non-negative number or null' } };
        }
        if (limit > 1000) {
          return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'limit exceeds max limit of 1000' } };
        }
      }
    }

    let results = [];
    for (const event of this._events) {
      if (event.workspaceId !== workspaceId) continue;
      if (actor && event.actor !== actor) continue;
      if (eventType && event.eventType !== eventType) continue;

      const t = new Date(event.createdAt).getTime();
      if (createdAfter !== null && t < createdAfter) continue;
      if (createdBefore !== null && t > createdBefore) continue;

      results.push(event);
    }

    results.sort((a, b) => {
      const t = a.createdAt.localeCompare(b.createdAt);
      return t !== 0 ? t : a.eventId.localeCompare(b.eventId);
    });

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
      ok: true,
      events: results,
      total,
      limit: limit === Infinity ? null : limit,
      offset
    };
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
    const workspaceId = normalizeWorkspaceId(opts.workspaceId);
    const includeTombstoned = opts.includeTombstoned === true;

    const memories = [];
    const events = [];
    const links = [];

    for (const record of this._memories.values()) {
      if (record.workspaceId !== workspaceId) continue;
      if (!includeTombstoned && record.status === 'deleted') continue;
      memories.push({
        memoryId: record.memoryId,
        workspaceId: record.workspaceId,
        content: record.content,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt || undefined,
        deletedAt: record.deletedAt || undefined,
        supersedesMemoryId: record.supersedesMemoryId || undefined,
        status: record.status,
        metadata: record.metadata,
        provenance: record.provenance,
        trustPolicyVersion: record.trustPolicyVersion,
      });
    }

    for (const event of this._events) {
      if (event.workspaceId !== workspaceId) continue;
      events.push({
        eventId: event.eventId,
        eventType: event.eventType,
        memoryId: event.memoryId,
        workspaceId: event.workspaceId,
        createdAt: event.createdAt,
        actor: event.actor,
        provenance: event.provenance,
        trustPolicyVersion: event.trustPolicyVersion,
        details: event.details,
        reviewedAt: event.reviewedAt || undefined,
        reviewedBy: event.reviewedBy || undefined,
        relatedMemoryId: event.relatedMemoryId || undefined,
      });
    }

    for (const link of this._links) {
      if (link.workspaceId !== workspaceId) continue;
      links.push({
        linkId: link.linkId,
        relation: link.relation,
        fromMemoryId: link.fromMemoryId,
        toMemoryId: link.toMemoryId,
        workspaceId: link.workspaceId,
        createdAt: link.createdAt,
        provenance: link.provenance,
        trustPolicyVersion: link.trustPolicyVersion,
        strength: link.strength !== undefined ? link.strength : undefined,
        metadata: link.metadata || undefined,
      });
    }

    const pkg = {
      version: '1.0.0',
      schemaVersion: 'memory-package-v1',
      workspaceId: workspaceId,
      memories,
      events,
      links,
    };

    const validation = validateMemoryPackage(pkg);
    if (!validation.ok) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'exported package failed validation', details: validation.errors } };
    }

    return { ok: true, package: pkg };
  }

  /**
   * Import a memory package into a workspace.
   * @param {object} pkg - { version, schemaVersion, workspaceId, memories, events, links }
   * @param {object} opts - { targetWorkspaceId?, mode? }
   * @returns {{ ok: boolean, imported?: { memories: number, events: number, links: number }, error?: object }}
   */
  importPackage(pkg, opts = {}) {
    const validation = validateMemoryPackage(pkg);
    if (!validation.ok) {
      return { ok: false, error: { code: 'INVALID_PACKAGE', message: 'package failed validation', details: validation.errors } };
    }

    const targetWorkspaceId = normalizeWorkspaceId(opts.targetWorkspaceId);
    const mode = opts.mode || 'idempotent';

    if (!Array.isArray(pkg.memories) || !Array.isArray(pkg.events) || !Array.isArray(pkg.links)) {
      return { ok: false, error: { code: 'INVALID_PACKAGE', message: 'package must contain memories, events, and links arrays' } };
    }

    const imported = { memories: 0, events: 0, links: 0 };
    const skipped = { memories: 0, events: 0, links: 0 };
    const conflicts = [];

    const snapshot = this._snapshotInMemoryState();
    try {
      this._withTransaction(() => {
        for (const mem of pkg.memories) {
          const memWs = targetWorkspaceId;
          const existing = this._findMemory(mem.memoryId, memWs);
          const contentHash = getContentHash(mem.content);

          if (existing) {
            const existingHash = getContentHash(existing.content);
            if (existingHash === contentHash && existing.workspaceId === memWs) {
              skipped.memories++;
              continue;
            }
            if (mode === 'idempotent') {
              conflicts.push({ type: 'memory', memoryId: mem.memoryId, reason: 'different content for same id' });
              continue;
            }
          }

          const normalized = normalizeMemoryRecord({
            memoryId: mem.memoryId,
            workspaceId: memWs,
            content: mem.content,
            createdAt: mem.createdAt,
            updatedAt: mem.updatedAt || undefined,
            deletedAt: mem.deletedAt || undefined,
            supersedesMemoryId: mem.supersedesMemoryId || undefined,
            status: mem.status || 'active',
            metadata: mem.metadata || {},
            provenance: mem.provenance,
            trustPolicyVersion: mem.trustPolicyVersion,
          });

          const memValidation = validateMemoryRecord(normalized);
          if (!memValidation.ok) {
            conflicts.push({ type: 'memory', memoryId: mem.memoryId, reason: memValidation.errors });
            continue;
          }

          if (this._db) {
            this._stmts.upsertMemory.run({
              workspace_id: normalized.workspaceId,
              memory_id: normalized.memoryId,
              kind: 'memory-record',
              content_json: JSON.stringify(normalized.content),
              content_hash: contentHash,
              status: normalized.status,
              metadata_json: JSON.stringify(normalized.metadata),
              provenance_json: JSON.stringify(normalized.provenance),
              trust_policy_version: normalized.trustPolicyVersion,
              created_at: normalized.createdAt,
              updated_at: normalized.updatedAt || null,
              deleted_at: normalized.deletedAt || null,
              supersedes_memory_id: normalized.supersedesMemoryId || null,
            });
          }

          Object.freeze(normalized.content);
          this._memories.set(this._makeMemoryKey(normalized.workspaceId, normalized.memoryId), normalized);
          imported.memories++;
        }

        for (const evt of pkg.events) {
          const evtWs = targetWorkspaceId;
          const normalizedEvt = normalizeMemoryEvent({
            eventId: evt.eventId,
            eventType: evt.eventType,
            memoryId: evt.memoryId,
            workspaceId: evtWs,
            createdAt: evt.createdAt,
            actor: evt.actor,
            provenance: evt.provenance,
            trustPolicyVersion: evt.trustPolicyVersion,
            details: evt.details,
            reviewedAt: evt.reviewedAt || undefined,
            reviewedBy: evt.reviewedBy || undefined,
            relatedMemoryId: evt.relatedMemoryId || undefined,
          });

          const evtValidation = validateMemoryEvent(normalizedEvt);
          if (!evtValidation.ok) {
            conflicts.push({ type: 'event', eventId: evt.eventId, reason: evtValidation.errors });
            continue;
          }

          if (this._db) {
            this._stmts.insertEvent.run({
              workspace_id: normalizedEvt.workspaceId,
              event_id: normalizedEvt.eventId,
              event_type: normalizedEvt.eventType,
              memory_id: normalizedEvt.memoryId,
              actor: normalizedEvt.actor,
              details_json: JSON.stringify(normalizedEvt.details),
              provenance_json: JSON.stringify(normalizedEvt.provenance),
              trust_policy_version: normalizedEvt.trustPolicyVersion,
              created_at: normalizedEvt.createdAt,
            });
          }

          this._events.push(normalizedEvt);
          imported.events++;
        }

        for (const lnk of pkg.links) {
          const lnkWs = targetWorkspaceId;
          const normalizedLnk = normalizeMemoryLink({
            linkId: lnk.linkId,
            relation: lnk.relation,
            fromMemoryId: lnk.fromMemoryId,
            toMemoryId: lnk.toMemoryId,
            workspaceId: lnkWs,
            createdAt: lnk.createdAt,
            provenance: lnk.provenance,
            trustPolicyVersion: lnk.trustPolicyVersion,
            strength: lnk.strength,
            metadata: lnk.metadata || {},
          });

          const lnkValidation = validateMemoryLink(normalizedLnk);
          if (!lnkValidation.ok) {
            conflicts.push({ type: 'link', linkId: lnk.linkId, reason: lnkValidation.errors });
            continue;
          }

          if (this._db) {
            this._stmts.insertLink.run({
              workspace_id: normalizedLnk.workspaceId,
              link_id: normalizedLnk.linkId,
              relation: normalizedLnk.relation,
              from_memory_id: normalizedLnk.fromMemoryId,
              to_memory_id: normalizedLnk.toMemoryId,
              confidence: normalizedLnk.strength,
              provenance_json: JSON.stringify(normalizedLnk.provenance),
              trust_policy_version: normalizedLnk.trustPolicyVersion,
              created_at: normalizedLnk.createdAt,
            });
          }

          this._links.push(normalizedLnk);
          imported.links++;
        }
      });
    } catch (err) {
      this._restoreInMemoryState(snapshot);
      return this._persistenceError('importPackage', err);
    }

    if (conflicts.length > 0 && mode === 'strict') {
      return { ok: false, error: { code: 'CONFLICT', message: 'import conflicts detected', details: conflicts } };
    }

    return { ok: true, imported, conflicts: conflicts.length > 0 ? conflicts : undefined };
  }
}

module.exports = MemoryStore;
