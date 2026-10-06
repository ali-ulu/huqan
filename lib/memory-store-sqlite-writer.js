'use strict';

// Delegated from lib/memory-store.js (MemoryStore SQLite persistence) by #2129.
// The store retains handle/collection ownership: it passes itself in and the
// functions below touch only store._db, store._stmts, store.withTransaction
// and store.persistenceError — both public since #2129, the same seam
// memory-package-import-runner.js already documents. No behaviour decision
// statement is moved verbatim from the persist closures it replaces.
//
// #2906: SQLite only. Choosing between SQLite, JSON and in-memory persistence
// is lib/memory-store-port.js's job; it calls these functions only while a
// handle is open.

const { getContentHash, resolveDbPath } = require('./memory-store-utils');
const { CONTENT_KIND_SQL, initMemorySchema, createMemoryStmts } = require('./memory-store-sqlite-schema');
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
    reviewed_at: event.reviewedAt || null,
    reviewed_by: event.reviewedBy || null,
    schema_version: event.schemaVersion || null,
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
    metadata_json: link.metadata === undefined || link.metadata === null ? null : JSON.stringify(link.metadata),
    schema_version: link.schemaVersion || null,
    supersedes_hash: link.supersedesHash || null,
    new_content_hash: link.newContentHash || null,
  });
}

function persistStoreWrite(store, record, event) {
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
        supersedes_hash: record.supersedesHash || null,
      });
      writeEventRow(store, event);
    });
  } catch (err) {
    return store.persistenceError('store', err);
  }
  return undefined;
}

function persistLinkMemories(store, payload) {
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
        supersedes_hash: record.supersedesHash || null,
      });
      writeEventRow(store, event);
    });
  } catch (err) {
    return store.persistenceError('patchMetadata', err);
  }
  return undefined;
}

function persistTombstone(store, payload) {
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
        supersedes_hash: record.supersedesHash || null,
      });
      writeEventRow(store, event);
    });
  } catch (err) {
    return store.persistenceError('tombstone', err);
  }
  return undefined;
}

function persistSupersede(store, ops) {
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
        supersedes_hash: newRecord.supersedesHash || null,
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
        supersedes_hash: oldRecord.supersedesHash || null,
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
    supersedes_hash: record.supersedesHash || null,
  });
}

module.exports = {
  CONTENT_KIND_SQL,
  initMemorySchema,
  createMemoryStmts,
  openMemoryDatabase,
  persistStoreWrite,
  persistLinkMemories,
  persistPatchMetadata,
  persistTombstone,
  persistSupersede,
  persistImportMemory,
  writeEventRow,
  writeLinkRow,
};
