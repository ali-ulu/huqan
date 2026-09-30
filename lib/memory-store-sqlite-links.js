'use strict';

// #3208 slice 3: SQLite is the source of truth for memory links. This set
// stands where the full `_links` array stood on the SQLite backend: writes
// already reach SQLite through writeLinkRow before `push` is called, so
// `push` keeps nothing, and reads are indexed per workspace, per memory
// (either endpoint) or per link key. A row that fails validation is never
// returned.

const { parseLinkRow } = require('./memory-store-sqlite-row');
const { openStatements } = require('./memory-store-sqlite-collection');

function validLinks(rows) {
  const links = [];
  for (const row of rows) {
    const { link } = parseLinkRow(row);
    if (link) links.push(link);
  }
  return links;
}

class SqliteLinkSet {
  constructor(store) {
    this._store = store;
  }

  /** The write path has already persisted these links. */
  push(...links) {
    return links.length;
  }

  forWorkspace(workspaceId) {
    return validLinks(openStatements(this._store).linksForWorkspace.all(workspaceId));
  }

  forMemory(workspaceId, memoryId) {
    return validLinks(openStatements(this._store).linksForMemory.all(workspaceId, memoryId, workspaceId, memoryId));
  }

  find(workspaceId, linkId) {
    const row = openStatements(this._store).linkByKey.get(workspaceId, linkId);
    return row ? parseLinkRow(row).link : undefined;
  }
}

function createSqliteLinkSet(store) {
  return new SqliteLinkSet(store);
}

module.exports = { SqliteLinkSet, createSqliteLinkSet };
