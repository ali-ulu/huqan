'use strict';

const {
  normalizeMemoryRecord,
  validateMemoryRecord,
  validateMemoryEvent,
  validateMemoryLink,
} = require('./memory-schema');

const MAX_CORRUPT_ROWS = 1000;
const MAX_VALIDATION_ERRORS = 12;
const MAX_MESSAGE_LENGTH = 240;

function boundedValidationErrors(errors) {
  return (Array.isArray(errors) ? errors : [{ code: 'INVALID_ROW', message: 'row validation failed' }])
    .slice(0, MAX_VALIDATION_ERRORS)
    .map((error) => ({
      code: String(error && error.code || 'INVALID_ROW').slice(0, 80),
      ...(error && error.field ? { field: String(error.field).slice(0, 120) } : {}),
      message: String(error && error.message || 'row validation failed').slice(0, MAX_MESSAGE_LENGTH),
    }));
}

function quarantine(store, kind, id, errors) {
  const finding = Object.freeze({
    kind,
    id: String(id || '').slice(0, 200),
    errors: boundedValidationErrors(errors),
  });
  if (store.corruptRows.length < MAX_CORRUPT_ROWS) store.corruptRows.push(finding);
  if (!store._strictWarmup) return null;
  const error = new Error(`Corrupt ${kind} row found in SQLite during warmup: ${finding.id}.`);
  error.code = 'MEMORY_STORE_CORRUPT_ROW';
  error.details = finding;
  throw error;
}

function parseJson(value, field) {
  try {
    return JSON.parse(value);
  } catch (_) {
    const error = new Error(`${field} is not valid JSON`);
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function loadMemory(store, row) {
  try {
    const record = normalizeMemoryRecord({
      memoryId: row.memory_id,
      workspaceId: row.workspace_id,
      content: parseJson(row.content_json, 'content_json'),
      createdAt: row.created_at,
      updatedAt: row.updated_at || undefined,
      deletedAt: row.deleted_at || undefined,
      supersedesMemoryId: row.supersedes_memory_id || undefined,
      status: row.status,
      metadata: parseJson(row.metadata_json, 'metadata_json'),
      provenance: parseJson(row.provenance_json, 'provenance_json'),
      trustPolicyVersion: row.trust_policy_version,
    });
    const validation = validateMemoryRecord(record);
    if (!validation.ok) return quarantine(store, 'memory', row.memory_id, validation.errors);
    Object.freeze(record.content);
    store._memories.set(store._makeMemoryKey(row.workspace_id, row.memory_id), record);
    return record;
  } catch (error) {
    if (error && error.code === 'MEMORY_STORE_CORRUPT_ROW') throw error;
    return quarantine(store, 'memory', row.memory_id, [{ code: error.code || 'PARSE_ERROR', message: error.message }]);
  }
}

function loadEvent(store, row) {
  try {
    const event = {
      eventId: row.event_id,
      eventType: row.event_type,
      memoryId: row.memory_id,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      actor: row.actor,
      provenance: parseJson(row.provenance_json, 'provenance_json'),
      trustPolicyVersion: row.trust_policy_version,
      details: parseJson(row.details_json, 'details_json'),
      relatedMemoryId: row.related_memory_id || undefined,
    };
    const validation = validateMemoryEvent(event);
    if (!validation.ok) return quarantine(store, 'event', row.event_id, validation.errors);
    store._events.push(event);
    return event;
  } catch (error) {
    if (error && error.code === 'MEMORY_STORE_CORRUPT_ROW') throw error;
    return quarantine(store, 'event', row.event_id, [{ code: error.code || 'PARSE_ERROR', message: error.message }]);
  }
}

function loadLink(store, row) {
  try {
    const link = {
      linkId: row.link_id,
      relation: row.relation,
      fromMemoryId: row.from_memory_id,
      toMemoryId: row.to_memory_id,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      provenance: parseJson(row.provenance_json, 'provenance_json'),
      trustPolicyVersion: row.trust_policy_version,
      strength: row.confidence !== null ? row.confidence : undefined,
    };
    const validation = validateMemoryLink(link);
    if (!validation.ok) return quarantine(store, 'link', row.link_id, validation.errors);
    store._links.push(link);
    return link;
  } catch (error) {
    if (error && error.code === 'MEMORY_STORE_CORRUPT_ROW') throw error;
    return quarantine(store, 'link', row.link_id, [{ code: error.code || 'PARSE_ERROR', message: error.message }]);
  }
}

function warmup(store) {
  for (const row of store._stmts.allMemories.all()) loadMemory(store, row);
  for (const row of store._stmts.allEvents.all()) loadEvent(store, row);
  for (const row of store._stmts.allLinks.all()) loadLink(store, row);
}

// #1864: drop the in-memory cache so the next warmup() rebuilds it from the
// current database contents instead of appending to stale collections. Returns
// the store for chaining from reopen()-style call sites.
function resetWarmCache(store) {
  store._memories = new Map();
  store._events = [];
  store._links = [];
  store.corruptRows = [];
  return store;
}

// #1864: reopen path. Drop the cache first so the next warmup() rebuilds it
// from the current database contents instead of appending to stale
// collections. Returns the store for chaining from reopen()-style call sites.
function reopenWarmup(store) {
  resetWarmCache(store);
  warmup(store);
}

module.exports = { MAX_CORRUPT_ROWS, warmup, reopenWarmup };
