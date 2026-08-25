'use strict';

const { isDeepStrictEqual } = require('node:util');
const { getAuditEvents, normalizeAuditEvent } = require('./audit-log');
const { SIZE_LIMIT_CODE, measureJsonUtf8Bytes } = require('./json-utf8-size');

const AUDIT_EVENT_DETAILS_LIMIT_CODE = 'AUDIT_EVENT_DETAILS_LIMIT_EXCEEDED';
const AUDIT_EVENT_SOURCE_DIVERGENCE_CODE = 'AUDIT_EVENT_SOURCE_DIVERGENCE';
const AUDIT_EVENT_DETAILS_READ_ERROR_CODE = 'AUDIT_EVENT_DETAILS_READ_ERROR';
const BOUNDED_AUDIT_SOURCE_UNSUPPORTED_CODE = 'BOUNDED_AUDIT_SOURCE_UNSUPPORTED';

function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function exactWorkspace(filters) {
  const keys = Object.keys(filters).filter((key) => filters[key] !== undefined);
  if (keys.length !== 1 || keys[0] !== 'workspaceId'
    || typeof filters.workspaceId !== 'string' || !filters.workspaceId.trim()) {
    throw new TypeError('bounded audit iteration requires exactly one non-empty workspaceId filter');
  }
  return filters.workspaceId.trim();
}

function assertDetailsWithinLimit(details, maxDetailsBytes) {
  try {
    return measureJsonUtf8Bytes(details ?? {}, { maxBytes: maxDetailsBytes });
  } catch (error) {
    if (error?.code !== SIZE_LIMIT_CODE) throw error;
    throw codedError(AUDIT_EVENT_DETAILS_LIMIT_CODE,
      `audit event details exceed ${maxDetailsBytes} bytes`,
      { bytes: error.bytes, maxBytes: maxDetailsBytes });
  }
}

function rowToEvent(row, details) {
  return normalizeAuditEvent({
    auditId: row.audit_id,
    eventType: row.event_type,
    targetType: row.target_type || '',
    targetId: row.target_id || '',
    workspaceId: row.workspace_id || 'default',
    actor: row.actor || 'system',
    timestamp: row.timestamp,
    sourceRef: row.source_ref || '',
    provenanceId: row.provenance_id || '',
    trustPolicyVersion: row.trust_policy_version || '',
    details,
  });
}

function sqliteStatements(db) {
  const columns = `audit_id, event_type, target_type, target_id, workspace_id, actor,
    timestamp, source_ref, provenance_id, trust_policy_version,
    length(CAST(details AS BLOB)) AS details_bytes`;
  return {
    first: db.prepare(`SELECT ${columns} FROM audit_log
      WHERE workspace_id = ? ORDER BY timestamp ASC, audit_id ASC LIMIT 1`),
    next: db.prepare(`SELECT ${columns} FROM audit_log
      WHERE workspace_id = ? AND (timestamp > ? OR (timestamp = ? AND audit_id > ?))
      ORDER BY timestamp ASC, audit_id ASC LIMIT 1`),
    byId: db.prepare(`SELECT ${columns} FROM audit_log
      WHERE audit_id = ? AND workspace_id = ? LIMIT 1`),
    details: db.prepare('SELECT details FROM audit_log WHERE audit_id = ? AND workspace_id = ?'),
  };
}

function parsePersistedDetails(statement, row, workspaceId, maxDetailsBytes) {
  const bytes = Number(row.details_bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw codedError(AUDIT_EVENT_DETAILS_READ_ERROR_CODE,
      `invalid persisted details byte length for ${row.audit_id}`, { auditId: row.audit_id });
  }
  if (bytes > maxDetailsBytes) {
    throw codedError(AUDIT_EVENT_DETAILS_LIMIT_CODE,
      `audit event details exceed ${maxDetailsBytes} bytes`,
      { auditId: row.audit_id, bytes, maxBytes: maxDetailsBytes });
  }
  const persisted = statement.get(row.audit_id, workspaceId);
  if (!persisted || typeof persisted.details !== 'string') {
    throw codedError(AUDIT_EVENT_DETAILS_READ_ERROR_CODE,
      `persisted audit event details are unavailable for ${row.audit_id}`, { auditId: row.audit_id });
  }
  try {
    return JSON.parse(persisted.details || '{}');
  } catch (_) {
    throw codedError(AUDIT_EVENT_DETAILS_READ_ERROR_CODE,
      `persisted audit event details are invalid JSON for ${row.audit_id}`, { auditId: row.audit_id });
  }
}

function assertProcessLocalRowsAgree(source, workspaceId, statements, maxDetailsBytes) {
  for (const memoryEvent of source._auditEvents || []) {
    if (getAuditEvents([memoryEvent], { workspaceId }).length === 0) continue;
    const row = statements.byId.get(memoryEvent.auditId, workspaceId);
    if (!row) {
      throw codedError(AUDIT_EVENT_SOURCE_DIVERGENCE_CODE,
        `in-memory audit event has no durable row for ${memoryEvent.auditId}`,
        { auditId: memoryEvent.auditId });
    }
    const details = parsePersistedDetails(statements.details, row, workspaceId, maxDetailsBytes);
    const durableEvent = rowToEvent(row, details);
    if (!isDeepStrictEqual(normalizeAuditEvent(memoryEvent), durableEvent)) {
      throw codedError(AUDIT_EVENT_SOURCE_DIVERGENCE_CODE,
        `durable and in-memory audit event disagree for ${memoryEvent.auditId}`,
        { auditId: memoryEvent.auditId });
    }
  }
}

function* iterateSqlite(source, workspaceId, maxDetailsBytes) {
  const statements = sqliteStatements(source._db);
  // Validate the complete process-local mirror before exposing any durable row.
  // A consumer may stop a generator with return/break, which would otherwise
  // skip a post-loop consistency check entirely.
  assertProcessLocalRowsAgree(source, workspaceId, statements, maxDetailsBytes);
  let row = statements.first.get(workspaceId);
  while (row) {
    const details = parsePersistedDetails(statements.details, row, workspaceId, maxDetailsBytes);
    yield rowToEvent(row, details);
    const timestamp = row.timestamp;
    const auditId = row.audit_id;
    row = statements.next.get(workspaceId, timestamp, timestamp, auditId);
  }
}

function* iterateMemory(source, workspaceId, maxDetailsBytes) {
  const events = Array.isArray(source) ? source : source?._auditEvents;
  if (!Array.isArray(events)) {
    throw codedError(BOUNDED_AUDIT_SOURCE_UNSUPPORTED_CODE, 'bounded audit source is not supported');
  }
  for (const event of events) {
    if (getAuditEvents([event], { workspaceId }).length === 0) continue;
    assertDetailsWithinLimit(event?.details ?? {}, maxDetailsBytes);
    yield event;
  }
}

function iterateAuditEventsBounded(source, filters = {}, options = {}) {
  const workspaceId = exactWorkspace(filters);
  const maxDetailsBytes = options.maxDetailsBytes;
  if (!Number.isSafeInteger(maxDetailsBytes) || maxDetailsBytes < 0) {
    throw new TypeError('iterateAuditEventsBounded requires maxDetailsBytes to be a non-negative safe integer');
  }
  if (source?._db && source?._stmts) return iterateSqlite(source, workspaceId, maxDetailsBytes);
  return iterateMemory(source, workspaceId, maxDetailsBytes);
}

module.exports = {
  AUDIT_EVENT_DETAILS_LIMIT_CODE,
  AUDIT_EVENT_SOURCE_DIVERGENCE_CODE,
  AUDIT_EVENT_DETAILS_READ_ERROR_CODE,
  BOUNDED_AUDIT_SOURCE_UNSUPPORTED_CODE,
  iterateAuditEventsBounded,
};
