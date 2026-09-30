'use strict';

const {
  validateMemoryEvent,
  validateMemoryLink,
} = require('./memory-schema');
const { parseJson, parseMemoryRow } = require('./memory-store-sqlite-row');
const { createSqliteMemoryCollection } = require('./memory-store-sqlite-collection');

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

// #3208: memories stay in SQLite. Open still validates every row (corruption
// is reported at open, as before) but reads them in bounded chunks and keeps
// none, so open is linear in time and bounded in memory.
const SCAN_CHUNK_ROWS = 256;

function scanMemories(store) {
  let afterRowid = Number.MIN_SAFE_INTEGER;
  let invalid = 0;
  for (;;) {
    const rows = store._stmts.memoriesAfterRowid.all(afterRowid, SCAN_CHUNK_ROWS);
    for (const row of rows) {
      const parsed = parseMemoryRow(row);
      if (parsed.errors) {
        invalid++;
        quarantine(store, 'memory', row.memory_id, parsed.errors);
      }
    }
    if (rows.length < SCAN_CHUNK_ROWS) return invalid;
    afterRowid = rows[rows.length - 1].row_id;
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
  const invalidMemories = scanMemories(store);
  store._memories = createSqliteMemoryCollection(store, { invalidRows: invalidMemories });
  for (const row of store._stmts.allEvents.all()) loadEvent(store, row);
  for (const row of store._stmts.allLinks.all()) loadLink(store, row);
}

module.exports = { MAX_CORRUPT_ROWS, SCAN_CHUNK_ROWS, warmup };
