const { randomUUID } = require('crypto');

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

function getAuditEvents(target, filters = {}) {
  const source = Array.isArray(target)
    ? target
    : target && Array.isArray(target._auditEvents)
      ? target._auditEvents
      : [];
  return source.filter((event) => {
    if (filters.eventType && event.eventType !== filters.eventType) return false;
    if (filters.targetType && event.targetType !== filters.targetType) return false;
    if (filters.targetId && event.targetId !== filters.targetId) return false;
    if (filters.workspaceId && event.workspaceId !== filters.workspaceId) return false;
    if (filters.actor && event.actor !== filters.actor) return false;
    if (filters.provenanceId && event.provenanceId !== filters.provenanceId) return false;
    if (filters.trustPolicyVersion && event.trustPolicyVersion !== filters.trustPolicyVersion) return false;
    if (filters.sourceRef && event.sourceRef !== filters.sourceRef) return false;
    return true;
  });
}

module.exports = {
  AUDIT_EVENTS,
  appendAuditEvent,
  buildAuditEvent,
  getAuditEvents,
  normalizeAuditEvent,
};
