'use strict';

const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const {
  SIZE_LIMIT_CODE,
  measureJsonUtf8Bytes,
} = require('./json-utf8-size');

const AUDIT_EVENT_DETAILS_LIMIT_CODE = 'AUDIT_EVENT_DETAILS_LIMIT_EXCEEDED';
const AUDIT_EVENT_SOURCE_DIVERGENCE_CODE = 'AUDIT_EVENT_SOURCE_DIVERGENCE';
const AUDIT_EVENT_DETAILS_READ_ERROR_CODE = 'AUDIT_EVENT_DETAILS_READ_ERROR';

const AUDIT_EVENTS = Object.freeze({
  LEARN: 'LEARN',
  REJECT: 'REJECT',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  QUERY: 'QUERY',
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',
  CLAIM_FLAGGED: 'CLAIM_FLAGGED',
  CLAIM_ACCEPTED: 'CLAIM_ACCEPTED',
  CLAIM_REJECTED: 'CLAIM_REJECTED',
  REAFFIRMED: 'REAFFIRMED',
  IMPORTED: 'IMPORTED',
  EXPORTED: 'EXPORTED',
});

function nowIso() {
  return new Date().toISOString();
}

function coerceString(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value === 0) return '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function jsonSafeClone(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_key, current) => {
      if (typeof current === 'bigint') return current.toString();
      if (typeof current === 'function') return `[Function ${current.name || 'anonymous'}]`;
      if (typeof current === 'symbol') return current.toString();
      if (current instanceof Date) return current.toISOString();
      if (current === undefined) return null;
      return current;
    }));
  } catch (_) {
    return fallback;
  }
}

function normalizeAuditEvent(event = {}, opts = {}) {
  const provenance = opts.provenance && typeof opts.provenance === 'object'
    ? opts.provenance
    : (event.provenance && typeof event.provenance === 'object' ? event.provenance : null);
  const detailsSource = Object.prototype.hasOwnProperty.call(event, 'details')
    ? event.details
    : opts.details;
  const timestamp = coerceString(event.timestamp || opts.timestamp, nowIso());
  const workspaceId = coerceString(event.workspaceId || opts.workspaceId || provenance?.workspaceId, 'default');
  const actor = coerceString(event.actor || opts.actor || provenance?.actor, 'system');
  const sourceRef = coerceString(event.sourceRef || opts.sourceRef || provenance?.sourceRef, '');
  const provenanceId = coerceString(event.provenanceId || opts.provenanceId || provenance?.provenanceId, '');
  const trustPolicyVersion = coerceString(
    event.trustPolicyVersion || opts.trustPolicyVersion || provenance?.trustPolicyVersion,
    '',
  );
  const normalized = {
    auditId: coerceString(event.auditId || opts.auditId, randomUUID()),
    eventType: coerceString(event.eventType || opts.eventType, AUDIT_EVENTS.LEARN),
    targetType: coerceString(event.targetType || opts.targetType, ''),
    targetId: coerceString(event.targetId || opts.targetId, ''),
    workspaceId,
    actor,
    timestamp,
    sourceRef,
    provenanceId,
    trustPolicyVersion,
    details: jsonSafeClone(detailsSource, {}),
  };

  return normalized;
}

function buildAuditEvent(input = {}, opts = {}) {
  return normalizeAuditEvent(input, opts);
}

function appendAuditEvent(target, event, opts = {}) {
  const normalized = normalizeAuditEvent(event, opts);
  if (Array.isArray(target)) {
    target.push(normalized);
    return normalized;
  }
  if (target && Array.isArray(target._auditEvents)) {
    target._auditEvents.push(normalized);
    return normalized;
  }
  throw new Error('appendAuditEvent target is not supported');
}

function normalizeWorkspaceFilter(filters = {}) {
  if (!Object.prototype.hasOwnProperty.call(filters, 'workspaceId')) return undefined;
  const raw = filters.workspaceId;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && !raw.trim()) return null;
  return coerceString(raw, '');
}

function eventMatchesFilters(event, normalizedFilters) {
  if (normalizedFilters.eventType && event.eventType !== normalizedFilters.eventType) return false;
  if (normalizedFilters.targetType && event.targetType !== normalizedFilters.targetType) return false;
  if (normalizedFilters.targetId && event.targetId !== normalizedFilters.targetId) return false;
  if (normalizedFilters.workspaceId !== undefined && event.workspaceId !== normalizedFilters.workspaceId) return false;
  if (normalizedFilters.actor && event.actor !== normalizedFilters.actor) return false;
  if (normalizedFilters.provenanceId && event.provenanceId !== normalizedFilters.provenanceId) return false;
  if (normalizedFilters.trustPolicyVersion && event.trustPolicyVersion !== normalizedFilters.trustPolicyVersion) return false;
  if (normalizedFilters.sourceRef && event.sourceRef !== normalizedFilters.sourceRef) return false;
  return true;
}

function getAuditEvents(target, filters = {}) {
  const normalizedFilters = { ...filters };
  normalizedFilters.workspaceId = normalizeWorkspaceFilter(filters);
  const source = Array.isArray(target)
    ? target
    : target && Array.isArray(target._auditEvents)
      ? target._auditEvents
      : [];
  return source.filter((event) => eventMatchesFilters(event, normalizedFilters));
}

function auditReadError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assertDetailsWithinLimit(details, maxDetailsBytes) {
  try {
    return measureJsonUtf8Bytes(details ?? {}, { maxBytes: maxDetailsBytes });
  } catch (error) {
    if (error?.code !== SIZE_LIMIT_CODE) throw error;
    throw auditReadError(
      AUDIT_EVENT_DETAILS_LIMIT_CODE,
      `audit event details exceed ${maxDetailsBytes} bytes`,
      { bytes: error.bytes, maxBytes: maxDetailsBytes },
    );
  }
}

function sqliteRowToAuditEvent(row, details) {
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

function lastMemoryEventByAuditId(target, auditId) {
  const events = Array.isArray(target?._auditEvents) ? target._auditEvents : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.auditId === auditId) return events[i];
  }
  return null;
}

function assertDurableMemoryAgreement(target, durableEvent) {
  const memoryEvent = lastMemoryEventByAuditId(target, durableEvent.auditId);
  if (!memoryEvent) return;
  const normalizedMemory = normalizeAuditEvent(memoryEvent);
  if (!isDeepStrictEqual(normalizedMemory, durableEvent)) {
    throw auditReadError(
      AUDIT_EVENT_SOURCE_DIVERGENCE_CODE,
      `durable and in-memory audit event disagree for ${durableEvent.auditId}`,
      { auditId: durableEvent.auditId },
    );
  }
}

function* iterateSqliteAuditEventsBounded(target, normalizedFilters, maxDetailsBytes) {
  const workspaceId = normalizedFilters.workspaceId;
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') {
    throw new TypeError('bounded SQLite audit iteration requires an explicit workspaceId');
  }

  const headers = target._db.prepare(`
    SELECT
      audit_id,
      event_type,
      target_type,
      target_id,
      workspace_id,
      actor,
      timestamp,
      source_ref,
      provenance_id,
      trust_policy_version,
      length(CAST(details AS BLOB)) AS details_bytes
    FROM audit_log
    WHERE workspace_id = ?
    ORDER BY timestamp ASC, audit_id ASC
  `);
  const readDetails = target._db.prepare('SELECT details FROM audit_log WHERE audit_id = ? AND workspace_id = ?');

  for (const row of headers.iterate(workspaceId)) {
    const headerEvent = sqliteRowToAuditEvent(row, {});
    if (!eventMatchesFilters(headerEvent, normalizedFilters)) continue;

    const detailsBytes = Number(row.details_bytes || 0);
    if (!Number.isSafeInteger(detailsBytes) || detailsBytes < 0) {
      throw auditReadError(
        AUDIT_EVENT_DETAILS_READ_ERROR_CODE,
        `invalid persisted details byte length for ${row.audit_id}`,
        { auditId: row.audit_id },
      );
    }
    if (detailsBytes > maxDetailsBytes) {
      throw auditReadError(
        AUDIT_EVENT_DETAILS_LIMIT_CODE,
        `audit event details exceed ${maxDetailsBytes} bytes`,
        { auditId: row.audit_id, bytes: detailsBytes, maxBytes: maxDetailsBytes },
      );
    }

    const detailsRow = readDetails.get(row.audit_id, workspaceId);
    if (!detailsRow || typeof detailsRow.details !== 'string') {
      throw auditReadError(
        AUDIT_EVENT_DETAILS_READ_ERROR_CODE,
        `persisted audit event details are unavailable for ${row.audit_id}`,
        { auditId: row.audit_id },
      );
    }

    let details;
    try {
      details = JSON.parse(detailsRow.details || '{}');
    } catch (_) {
      throw auditReadError(
        AUDIT_EVENT_DETAILS_READ_ERROR_CODE,
        `persisted audit event details are invalid JSON for ${row.audit_id}`,
        { auditId: row.audit_id },
      );
    }

    const durableEvent = sqliteRowToAuditEvent(row, details);
    assertDurableMemoryAgreement(target, durableEvent);
    yield durableEvent;
  }

  const exists = target._db.prepare('SELECT 1 AS present FROM audit_log WHERE audit_id = ? AND workspace_id = ?');
  for (const memoryEvent of target._auditEvents || []) {
    if (!eventMatchesFilters(memoryEvent, normalizedFilters)) continue;
    if (!exists.get(memoryEvent.auditId, workspaceId)) {
      throw auditReadError(
        AUDIT_EVENT_SOURCE_DIVERGENCE_CODE,
        `in-memory audit event has no durable row for ${memoryEvent.auditId}`,
        { auditId: memoryEvent.auditId },
      );
    }
  }
}

function* iterateMemoryAuditEventsBounded(target, normalizedFilters, maxDetailsBytes) {
  const source = Array.isArray(target)
    ? target
    : target && Array.isArray(target._auditEvents)
      ? target._auditEvents
      : [];
  for (const event of source) {
    if (!eventMatchesFilters(event, normalizedFilters)) continue;
    assertDetailsWithinLimit(event?.details ?? {}, maxDetailsBytes);
    yield event;
  }
}

function iterateAuditEventsBounded(target, filters = {}, options = {}) {
  const maxDetailsBytes = options.maxDetailsBytes;
  if (!Number.isSafeInteger(maxDetailsBytes) || maxDetailsBytes < 0) {
    throw new TypeError('iterateAuditEventsBounded requires maxDetailsBytes to be a non-negative safe integer');
  }
  const normalizedFilters = { ...filters };
  normalizedFilters.workspaceId = normalizeWorkspaceFilter(filters);
  if (target && target._db && target._stmts) {
    return iterateSqliteAuditEventsBounded(target, normalizedFilters, maxDetailsBytes);
  }
  return iterateMemoryAuditEventsBounded(target, normalizedFilters, maxDetailsBytes);
}

module.exports = {
  AUDIT_EVENTS,
  AUDIT_EVENT_DETAILS_LIMIT_CODE,
  AUDIT_EVENT_SOURCE_DIVERGENCE_CODE,
  AUDIT_EVENT_DETAILS_READ_ERROR_CODE,
  appendAuditEvent,
  buildAuditEvent,
  getAuditEvents,
  iterateAuditEventsBounded,
  normalizeAuditEvent,
};
