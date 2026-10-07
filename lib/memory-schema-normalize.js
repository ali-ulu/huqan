// #2174: normalizing records, events and links to their stored shape.

const { normalizeWorkspaceId } = require('./workspace-id');
const { isPlainObject } = require('./is-plain-object');
const { cloneJson: clone } = require('./json-clone');

function normalizeMemoryRecord(record = {}) {
  const next = clone(record) || {};
  if (next.workspaceId !== undefined) next.workspaceId = normalizeWorkspaceId(next.workspaceId);
  else next.workspaceId = 'default';
  if (next.trustPolicyVersion !== undefined && next.trustPolicyVersion !== null) next.trustPolicyVersion = String(next.trustPolicyVersion).trim();
  if (next.memoryId !== undefined && next.memoryId !== null) next.memoryId = String(next.memoryId).trim();
  if (next.createdAt !== undefined && next.createdAt !== null) next.createdAt = String(next.createdAt).trim();
  if (next.updatedAt !== undefined && next.updatedAt !== null) next.updatedAt = String(next.updatedAt).trim();
  if (next.deletedAt !== undefined && next.deletedAt !== null) next.deletedAt = String(next.deletedAt).trim();
  if (next.archivedAt !== undefined && next.archivedAt !== null) next.archivedAt = String(next.archivedAt).trim();
  if (next.supersedesMemoryId !== undefined && next.supersedesMemoryId !== null) next.supersedesMemoryId = String(next.supersedesMemoryId).trim();
  if (next.supersedesHash !== undefined && next.supersedesHash !== null) next.supersedesHash = String(next.supersedesHash).trim();
  if (next.status !== undefined && next.status !== null) next.status = String(next.status).trim();
  if (next.provenance && isPlainObject(next.provenance)) {
    next.provenance = clone(next.provenance);
    next.provenance.workspaceId = normalizeWorkspaceId(next.provenance.workspaceId || next.workspaceId);
    if (next.provenance.provenanceId !== undefined && next.provenance.provenanceId !== null) {
      next.provenance.provenanceId = String(next.provenance.provenanceId).trim();
    }
    ['sourceRef', 'sourceTitle', 'sourceType', 'actor', 'timestamp', 'trustPolicyVersion'].forEach((field) => {
      if (next.provenance[field] !== undefined && next.provenance[field] !== null) {
        next.provenance[field] = String(next.provenance[field]).trim();
      }
    });
    if (next.provenance.confidence !== undefined && next.provenance.confidence !== null) {
      next.provenance.confidence = Number(next.provenance.confidence);
    }
  }
  return next;
}

function normalizeMemoryEvent(event = {}) {
  const next = clone(event) || {};
  if (next.workspaceId !== undefined) next.workspaceId = normalizeWorkspaceId(next.workspaceId);
  else next.workspaceId = 'default';
  ['eventId', 'eventType', 'memoryId', 'createdAt', 'actor', 'trustPolicyVersion', 'reviewedBy', 'relatedMemoryId'].forEach((field) => {
    if (next[field] !== undefined && next[field] !== null) next[field] = String(next[field]).trim();
  });
  if (next.provenance && isPlainObject(next.provenance)) {
    next.provenance = clone(next.provenance);
    next.provenance.workspaceId = normalizeWorkspaceId(next.provenance.workspaceId || next.workspaceId);
    if (next.provenance.trustPolicyVersion !== undefined && next.provenance.trustPolicyVersion !== null) {
      next.provenance.trustPolicyVersion = String(next.provenance.trustPolicyVersion).trim();
    }
  }
  return next;
}

function ensureMemoryEventRelatedMemoryColumn(db) {
  const columns = db.prepare('PRAGMA table_info(memory_events)').all();
  if (!columns.some((column) => column.name === 'related_memory_id')) {
    db.exec('ALTER TABLE memory_events ADD COLUMN related_memory_id TEXT');
  }
}

// #3208: event fields the table used to drop, so an event read back from
// SQLite lost them at the next restart. Rows written before keep NULL, which
// reads back as the field being absent, as it did after a restart.
const MEMORY_EVENT_EXTRA_COLUMNS = ['reviewed_at', 'reviewed_by', 'schema_version'];
// Slice 3: the same loss for a link's metadata and schemaVersion.
const MEMORY_LINK_EXTRA_COLUMNS = ['metadata_json', 'schema_version', 'supersedes_hash', 'new_content_hash'];

function ensureTextColumns(db, table, columns) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const column of columns) {
    if (!present.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
}

function ensureMemoryEventColumns(db) {
  ensureTextColumns(db, 'memory_events', MEMORY_EVENT_EXTRA_COLUMNS);
}

function ensureMemoryLinkColumns(db) {
  ensureTextColumns(db, 'memory_links', MEMORY_LINK_EXTRA_COLUMNS);
}

// #3492: the supersede hash the table used to drop. Rows written before keep
// NULL, which reads back as the field being absent, as it did before.
// #3493: `archived_at` added with the archive status writer.
const MEMORY_RECORD_EXTRA_COLUMNS = ['supersedes_hash', 'archived_at'];

function ensureMemoryRecordColumns(db) {
  ensureTextColumns(db, 'memories', MEMORY_RECORD_EXTRA_COLUMNS);
}

function normalizeMemoryLink(link = {}) {
  const next = clone(link) || {};
  if (next.workspaceId !== undefined) next.workspaceId = normalizeWorkspaceId(next.workspaceId);
  else next.workspaceId = 'default';
  ['linkId', 'relation', 'fromMemoryId', 'toMemoryId', 'createdAt', 'trustPolicyVersion'].forEach((field) => {
    if (next[field] !== undefined && next[field] !== null) next[field] = String(next[field]).trim();
  });
  ['supersedesHash', 'newContentHash'].forEach((field) => {
    if (next[field] !== undefined && next[field] !== null) next[field] = String(next[field]).trim();
  });
  if (next.strength !== undefined && next.strength !== null) next.strength = Number(next.strength);
  if (next.provenance && isPlainObject(next.provenance)) {
    next.provenance = clone(next.provenance);
    next.provenance.workspaceId = normalizeWorkspaceId(next.provenance.workspaceId || next.workspaceId);
    if (next.provenance.trustPolicyVersion !== undefined && next.provenance.trustPolicyVersion !== null) {
      next.provenance.trustPolicyVersion = String(next.provenance.trustPolicyVersion).trim();
    }
  }
  return next;
}

module.exports = {
  ensureMemoryEventRelatedMemoryColumn,
  ensureMemoryEventColumns,
  ensureMemoryLinkColumns,
  ensureMemoryRecordColumns,
  normalizeMemoryEvent,
  normalizeMemoryLink,
  normalizeMemoryRecord,
};
