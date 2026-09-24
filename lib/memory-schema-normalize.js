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
  if (next.supersedesMemoryId !== undefined && next.supersedesMemoryId !== null) next.supersedesMemoryId = String(next.supersedesMemoryId).trim();
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

function normalizeMemoryLink(link = {}) {
  const next = clone(link) || {};
  if (next.workspaceId !== undefined) next.workspaceId = normalizeWorkspaceId(next.workspaceId);
  else next.workspaceId = 'default';
  ['linkId', 'relation', 'fromMemoryId', 'toMemoryId', 'createdAt', 'trustPolicyVersion'].forEach((field) => {
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
  normalizeMemoryEvent,
  normalizeMemoryLink,
  normalizeMemoryRecord,
};
