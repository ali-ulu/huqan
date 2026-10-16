'use strict';

const { parseEventRow, parseLinkRow, parseMemoryRow } = require('./memory-store-sqlite-row');
const { createSqliteMemoryCollection } = require('./memory-store-sqlite-collection');
const { createSqliteEventLog } = require('./memory-store-sqlite-events');
const { createSqliteLinkSet } = require('./memory-store-sqlite-links');

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

// #3208: memories, events and links stay in SQLite. Open still validates every row
// (corruption is reported at open, as before) but reads them in bounded
// chunks and keeps none, so open is linear in time and bounded in memory.
const SCAN_CHUNK_ROWS = 256;

/** Validate every row of one table in rowid chunks; returns the invalid count. */
function scanRows(store, statement, parse, kind, idColumn) {
  let afterRowid = Number.MIN_SAFE_INTEGER;
  let invalid = 0;
  for (;;) {
    const rows = statement.all(afterRowid, SCAN_CHUNK_ROWS);
    for (const row of rows) {
      const parsed = parse(row);
      if (parsed.errors) {
        invalid++;
        quarantine(store, kind, row[idColumn], parsed.errors);
      }
    }
    if (rows.length < SCAN_CHUNK_ROWS) return invalid;
    afterRowid = rows[rows.length - 1].row_id;
  }
}

function warmup(store) {
  const invalidMemories = scanRows(store, store._stmts.memoriesAfterRowid, parseMemoryRow, 'memory', 'memory_id');
  store._memories = createSqliteMemoryCollection(store, { invalidRows: invalidMemories });
  scanRows(store, store._stmts.eventsAfterRowid, parseEventRow, 'event', 'event_id');
  store._events = createSqliteEventLog(store);
  scanRows(store, store._stmts.linksAfterRowid, parseLinkRow, 'link', 'link_id');
  store._links = createSqliteLinkSet(store);
}

module.exports = { MAX_CORRUPT_ROWS, SCAN_CHUNK_ROWS, warmup };
