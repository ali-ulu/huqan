'use strict';

const DEFAULT_MAX_AUDIT_EVENTS = 1024;
const MAX_AUDIT_EVENTS_LIMIT = 1024;

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function exactIdentifier(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return '';
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function fail(code, message) {
  const error = new Error(message);
  error.name = 'MemoryContextAuditSourceError';
  error.code = code;
  throw error;
}

function normalizeLimit(value) {
  if (value === undefined) return DEFAULT_MAX_AUDIT_EVENTS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_AUDIT_EVENTS_LIMIT) {
    fail('INVALID_AUDIT_SCAN_LIMIT', 'maxAuditEvents must be an integer between 1 and 1024');
  }
  return value;
}

function statusForDecision(decision) {
  if (decision === 'allow') return 'admitted';
  if (decision === 'review') return 'review_required';
  if (decision === 'reject') return 'rejected';
  if (decision === 'quarantine' || decision === 'block') return 'blocked';
  return '';
}

function mapAuditEvent(event, workspaceId) {
  const details = event.details === undefined ? {} : event.details;
  if (!isPlainObject(details)) {
    fail('INVALID_AUDIT_EVENT', 'audit event details must be an object when present');
  }
  if (details.receipt !== undefined && !isPlainObject(details.receipt)) {
    fail('INVALID_AUDIT_EVENT', 'audit event receipt must be an object when present');
  }
  const receipt = details.receipt || null;
  const decision = trimText(details.admissionOutcome || receipt?.decision);
  const status = statusForDecision(decision);
  if (!status) return null;

  const receiptId = trimText(details.receiptId || receipt?.receiptId) || null;
  const canonicalMutation = Boolean(
    decision === 'allow'
      && receipt?.canonical === true
      && event.targetType === 'edge'
      && (event.eventType === 'LEARN' || event.eventType === 'REAFFIRMED'),
  );

  return {
    recordId: event.auditId,
    workspaceId,
    memoryAdmission: {
      status,
      decision,
      reason: trimText(details.reason || receipt?.reason) || null,
      workspaceId,
      receiptId,
      traceId: null,
      contextIntegrity: {
        workspaceScoped: true,
        canonicalMutation,
        mutationAllowed: canonicalMutation && decision === 'allow',
      },
    },
  };
}

function validateEvents(events, maxAuditEvents) {
  if (!Array.isArray(events)) {
    fail('INVALID_AUDIT_SOURCE_RESULT', 'getAuditEvents must return an array');
  }
  if (events.length > maxAuditEvents) {
    fail('AUDIT_SCAN_LIMIT_EXCEEDED', 'audit event scan limit exceeded');
  }
  for (const event of events) {
    if (
      !isPlainObject(event)
      || typeof event.auditId !== 'string'
      || !event.auditId.trim()
      || typeof event.workspaceId !== 'string'
      || !event.workspaceId.trim()
    ) {
      fail('INVALID_AUDIT_EVENT', 'audit source returned a malformed event');
    }
  }
  return events;
}

function createMemoryContextAuditSource(auditOwner, options = {}) {
  if (!auditOwner || typeof auditOwner.getAuditEvents !== 'function') {
    fail('INVALID_AUDIT_OWNER', 'auditOwner must expose getAuditEvents(filters)');
  }
  if (!isPlainObject(options)) {
    fail('INVALID_AUDIT_SOURCE_OPTIONS', 'options must be an object');
  }
  const maxAuditEvents = normalizeLimit(options.maxAuditEvents);

  return Object.freeze({
    readMemoryContext(query = {}) {
      if (!isPlainObject(query)) return null;
      const recordId = exactIdentifier(query.recordId);
      const workspaceId = exactIdentifier(query.workspaceId);
      if (!recordId || !workspaceId) return null;

      const events = validateEvents(
        auditOwner.getAuditEvents({ workspaceId }),
        maxAuditEvents,
      );
      const matches = events.filter((event) => (
        event.auditId === recordId && event.workspaceId === workspaceId
      ));
      if (matches.length === 0) return null;
      if (matches.length > 1) {
        fail('AMBIGUOUS_AUDIT_EVENT', 'multiple audit events matched the exact identifier');
      }
      return mapAuditEvent(matches[0], workspaceId);
    },
  });
}

module.exports = {
  createMemoryContextAuditSource,
};
