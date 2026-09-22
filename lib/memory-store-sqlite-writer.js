'use strict';

// Delegated from lib/memory-store.js (MemoryStore SQLite persistence) by #2129.
// The store retains handle/collection ownership: it passes itself in and the
// functions below touch only store._db, store._stmts, store.withTransaction
// and store.persistenceError — both public since #2129, the same seam
// memory-package-import-runner.js already documents. No behaviour decision
// statement is moved verbatim from the persist closures it replaces.

const jsonPersistence = require('./memory-store-json-persistence');
const { getContentHash, resolveDbPath } = require('./memory-store-utils');
const { ensureMemoryEventRelatedMemoryColumn } = require('./memory-schema');
const { applySqliteDurability } = require('./sqlite-durability');

// SQLite optional require. The load error is retained (not discarded) so the
// throw site can distinguish "not installed" from "installed but built for a
// different Node ABI" — two failures with different fixes.
const { loadSqliteDriver, sqliteUnavailableError } = require('./sqlite-availability');
const { Database, loadError: sqliteLoadError } = loadSqliteDriver();

/**
 * Open the SQLite backing database. Moved verbatim from the MemoryStore
 * constructor by #2129: the same flag semantics (truthy useSQLite without a
 * driver throws; only strict true opens), the same EVIDENCE durability, the
 * same resolved dbPath. Returns null when SQLite is not requested.
 */
function openMemoryDatabase({ useSQLite, dbPath, memoryPath, busyTimeoutMs }) {
  if (useSQLite && !Database) {
    throw sqliteUnavailableError('better-sqlite3 is required for SQLite memory storage.', sqliteLoadError);
  }
  if (useSQLite !== true) return null;
  const resolved = resolveDbPath({ dbPath, memoryPath });
  const db = new Database(resolved);
  // EVIDENCE, plus PR-S3B's bounded busy_timeout: memory_events is an audit
  // trail and is not derived, so its tail must survive a power cut. The
  // reasoning and the measured cost are in lib/sqlite-durability.js.
  applySqliteDurability(db, 'EVIDENCE', { busyTimeoutMs });
  return { db, dbPath: resolved };
}

function initMemorySchema(db) {
  db.exec(`
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
        created_at TEXT NOT NULL, related_memory_id TEXT,
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
  ensureMemoryEventRelatedMemoryColumn(db);
}

function createMemoryStmts(db) {
  return {
    upsertMemory: db.prepare(`
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
    insertEvent: db.prepare(`
        INSERT INTO memory_events (
          workspace_id, event_id, event_type, memory_id, actor, details_json,
          provenance_json, trust_policy_version, created_at, related_memory_id
        ) VALUES (
          @workspace_id, @event_id, @event_type, @memory_id, @actor, @details_json,
          @provenance_json, @trust_policy_version, @created_at, @related_memory_id
        )
      `),
    insertLink: db.prepare(`
        INSERT INTO memory_links (
          workspace_id, link_id, relation, from_memory_id, to_memory_id, confidence,
          provenance_json, trust_policy_version, created_at
        ) VALUES (
          @workspace_id, @link_id, @relation, @from_memory_id, @to_memory_id, @confidence,
          @provenance_json, @trust_policy_version, @created_at
        )
      `),
    allMemories: db.prepare(`SELECT * FROM memories`),
    allEvents: db.prepare(`SELECT * FROM memory_events`),
    allLinks: db.prepare(`SELECT * FROM memory_links`),
  };
}

function writeEventRow(store, event) {
  store._stmts.insertEvent.run({
    workspace_id: event.workspaceId,
    event_id: event.eventId,
    event_type: event.eventType,
    memory_id: event.memoryId,
    actor: event.actor,
    details_json: JSON.stringify(event.details),
    provenance_json: JSON.stringify(event.provenance),
    trust_policy_version: event.trustPolicyVersion,
    created_at: event.createdAt, related_memory_id: event.relatedMemoryId || null,
  });
}

function writeLinkRow(store, link) {
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
}

function persistStoreWrite(store, record, event) {
  if (!store._db) return jsonPersistence.persistJsonMutation(store, 'store', { record, event });
  try {
    store.withTransaction(() => {
      store._stmts.upsertMemory.run({
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
      writeEventRow(store, event);
    });
  } catch (err) {
    return store.persistenceError('store', err);
  }
  return undefined;
}

function persistLinkMemories(store, payload) {
  if (!store._db) return jsonPersistence.persistJsonMutation(store, 'linkMemories', payload);
  const { link, event } = payload;
  try {
    store.withTransaction(() => {
      writeLinkRow(store, link);
      writeEventRow(store, event);
    });
  } catch (err) {
    return store.persistenceError('linkMemories', err);
  }
  return undefined;
}

function persistPatchMetadata(store, payload) {
  if (!store._db) return jsonPersistence.persistJsonMutation(store, 'patchMetadata', payload);
  const { record, event, nextMetadata, now } = payload;
  try {
    store.withTransaction(() => {
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
      writeEventRow(store, event);
    });
  } catch (err) {
    return store.persistenceError('patchMetadata', err);
  }
  return undefined;
}

function persistTombstone(store, payload) {
  if (!store._db) return jsonPersistence.persistJsonMutation(store, 'tombstone', payload);
  const { record, event, now } = payload;
  try {
    store.withTransaction(() => {
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
      writeEventRow(store, event);
    });
  } catch (err) {
    return store.persistenceError('tombstone', err);
  }
  return undefined;
}

function persistSupersede(store, ops) {
  if (!store._db) return jsonPersistence.persistJsonMutation(store, 'supersede', ops);
  const { newRecord, oldRecord, link, event, oldMemoryUpdateEvent, getContentHash: hashFn } = ops;
  const now = new Date().toISOString();
  try {
    store.withTransaction(() => {
      // 1. Insert new memory record
      store._stmts.upsertMemory.run({
        workspace_id: newRecord.workspaceId,
        memory_id: newRecord.memoryId,
        kind: 'memory-record',
        content_json: JSON.stringify(newRecord.content),
        content_hash: hashFn(newRecord.content),
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
        content_hash: hashFn(oldRecord.content),
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
      writeLinkRow(store, link);

      // 4. Insert new memory event
      writeEventRow(store, event);

      // 5. Insert old memory update event
      writeEventRow(store, oldMemoryUpdateEvent);
    });
  } catch (err) {
    return store.persistenceError('supersede', err);
  }
  return undefined;
}

function persistImportMemory(store, record, contentHash) {
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
}

module.exports = {
  initMemorySchema,
  createMemoryStmts,
  openMemoryDatabase,
  persistStoreWrite,
  persistLinkMemories,
  persistPatchMetadata,
  persistTombstone,
  persistSupersede,
  persistImportMemory,
};
