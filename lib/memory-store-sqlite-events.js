'use strict';

// #3208 slice 2: SQLite is the source of truth for memory events. This log
// stands where the full `_events` array stood on the SQLite backend: writes
// already reach SQLite through writeEventRow before `push` is called (#761),
// so `push` keeps nothing, and reads are indexed per workspace, per memory or
// per related memory. A row that fails validation is never returned.

const { parseEventRow } = require('./memory-store-sqlite-row');
const { openStatements } = require('./memory-store-sqlite-collection');

function validEvents(rows) {
  const events = [];
  for (const row of rows) {
    const { event } = parseEventRow(row);
    if (event) events.push(event);
  }
  return events;
}

class SqliteEventLog {
  constructor(store) {
    this._store = store;
  }

  /** The write path has already persisted these events. */
  push(...events) {
    return events.length;
  }

  forWorkspace(workspaceId) {
    return validEvents(openStatements(this._store).eventsForWorkspace.all(workspaceId));
  }

  forMemory(workspaceId, memoryId) {
    return validEvents(openStatements(this._store).eventsForMemory.all(workspaceId, memoryId));
  }

  forHistory(workspaceId, memoryId) {
    return validEvents(openStatements(this._store).eventsForHistory.all(workspaceId, memoryId, workspaceId, memoryId));
  }

  has(workspaceId, eventId) {
    const row = openStatements(this._store).eventByKey.get(workspaceId, eventId);
    return Boolean(row && parseEventRow(row).event);
  }
}

function createSqliteEventLog(store) {
  return new SqliteEventLog(store);
}

module.exports = { SqliteEventLog, createSqliteEventLog };
