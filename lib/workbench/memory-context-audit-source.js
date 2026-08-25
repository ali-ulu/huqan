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

const { isPlainObject } = require('../is-plain-object');

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
  if (decision === 'allow' || decision === 'approved') return 'admitted';
  if (decision === 'review') return 'review_required';
  if (decision === 'reject' || decision === 'rejected') return 'rejected';
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
  const traceId = trimText(details.traceId || receipt?.traceId) || null;
  const canonicalMutation = Boolean(
    decision === 'allow'
      && receipt?.canonical === true
      && event.targetType === 'edge'
      && (event.eventType === 'LEARN' || event.eventType === 'REAFFIRMED'),
  );

  return {
    recordId: event.auditId,
    traceId,
    workspaceId,
    memoryAdmission: {
      status,
      decision,
      reason: trimText(details.reason || receipt?.reason) || null,
      workspaceId,
      receiptId,
      traceId,
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

/**
 * Read at most two rows for an exact (recordId, workspaceId) lookup: enough to
 * prove none, one, or ambiguous, and no more (#736).
 *
 * The previous shape asked for every event in the workspace and then checked
 * the length against maxAuditEvents. That bounded the accepted *result*, not
 * the work: the canonical Graph owner materializes, parses, merges and sorts
 * the matching history before the check can run, so looking up one identifier
 * cost O(total workspace audit history).
 */
function readExactAuditEvents(auditOwner, recordId, workspaceId, maxAuditEvents) {
  const filters = { workspaceId, auditId: recordId };

  if (typeof auditOwner.queryAuditEvents === 'function') {
    const page = auditOwner.queryAuditEvents({ filters, limit: 2 });
    if (!page || !Array.isArray(page.items)) {
      fail('INVALID_AUDIT_SOURCE_RESULT', 'queryAuditEvents must return an items array');
    }
    return validateEvents(page.items, maxAuditEvents);
  }

  // An owner without the bounded primitive still has to answer. Pushing the
  // identifier into the filter keeps the result exact even where the read
  // itself is not bounded, and the scan limit still applies.
  return validateEvents(auditOwner.getAuditEvents(filters), maxAuditEvents);
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

      const events = readExactAuditEvents(auditOwner, recordId, workspaceId, maxAuditEvents);
      // Re-asserted rather than assumed: the filter is already exact, so this
      // only guards against an owner that ignores one of the predicates.
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
