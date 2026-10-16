'use strict';

/**
 * Materialized receipt entries: the audit-event projection that
 * receipt-read-index.js reads from. Collects full receipt objects already
 * materialized into audit details (never synthesizing one), orders them the
 * same way receipt-stamp.js does, and projects them to their canonical payload.
 */

const { buildCanonicalReceiptPayload } = require('./canonical-receipt');
const {
  buildCanonicalReceiptPayloadV2,
  classifyRawMaterializedReceipt,
} = require('./canonical-receipt-v2');
const { classifyReceiptFamily, V4_RECEIPT_ERROR_CODES } = require('./v4-receipt-family');
const { toCanonicalVerdict } = require('../verdict/action-verdict');

const { isPlainObject } = require('../is-plain-object');
const { cloneJson: clone } = require('../json-clone');

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isReceiptCandidate(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch (_) {
    return false;
  }
}

function getAuditEvents(source, filters = {}) {
  if (source && typeof source.getAuditEvents === 'function') {
    return source.getAuditEvents(filters);
  }
  if (Array.isArray(source)) {
    return source.filter((event) => {
      if (filters.workspaceId && event.workspaceId !== filters.workspaceId) return false;
      if (filters.eventType && event.eventType !== filters.eventType) return false;
      if (filters.targetType && event.targetType !== filters.targetType) return false;
      return true;
    });
  }
  return [];
}

function publicAuditRef(event = {}) {
  return {
    auditId: trimText(event.auditId),
    eventType: trimText(event.eventType),
    targetType: trimText(event.targetType),
    targetId: trimText(event.targetId),
    workspaceId: trimText(event.workspaceId) || 'default',
    timestamp: trimText(event.timestamp),
  };
}

function receiptToCanonicalPayload(receipt, knownClassification) {
  if (!isPlainObject(receipt)) {
    throw new TypeError('receiptToCanonicalPayload requires a materialized receipt object');
  }
  const verdict = toCanonicalVerdict('admission', trimText(receipt.decision));
  const classification = knownClassification || classifyRawMaterializedReceipt(receipt);
  if (classification.kind === 'legacy_v1_unspecified') {
    return buildCanonicalReceiptPayload(receipt, { verdict });
  }
  if (classification.kind === 'v2') {
    return buildCanonicalReceiptPayloadV2(receipt, { verdict, trustRoot: classification.trustRoot });
  }
  const error = new TypeError(classification.kind === 'unsupported_schema_version'
    ? 'materialized receipt declares an unsupported canonical schema version'
    : 'materialized V2 receipt requires an exact valid trustRoot');
  error.causeCode = classification.kind === 'unsupported_schema_version'
    ? V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION
    : V4_RECEIPT_ERROR_CODES.INVALID_TRUST_ROOT;
  throw error;
}

// The chain and the stamp must be built over the same order, or the head of
// one is not the head of the other. receipt-stamp.js sorts its rows by
// (timestamp, auditId); this file walked getAuditEvents in raw store order. Any
// store that does not return audit events chronologically therefore produced a
// chain whose headHash disagreed with the headHash getReceiptStamp reported --
// and receipt-validation-cache keys on (headHash, receiptCount), so the
// disagreement turns into false cache hits and misses.
function byTimestampThenAuditId(left, right) {
  const timestampOrder = String(left?.timestamp || '').localeCompare(String(right?.timestamp || ''));
  return timestampOrder || String(left?.auditId || '').localeCompare(String(right?.auditId || ''));
}

function collectMaterializedReceiptEntries(source, filters = {}) {
  const workspaceId = trimText(filters.workspaceId);
  // Sorted before the de-duplication below, not after: with two audit events
  // carrying the same receiptId, raw order would decide which one is kept.
  const events = [...getAuditEvents(source, workspaceId ? { workspaceId } : {})].sort(byTimestampThenAuditId);
  const seen = new Set();
  const entries = [];

  for (const event of events) {
    const receipt = event && event.details && event.details.receipt;
    // A malformed object still needs an INVALID_RECEIPT response when its id
    // is requested. It must not silently disappear as NOT_FOUND just because
    // the shared boundary predicate rejected an inherited or exotic record.
    if (!isReceiptCandidate(receipt)) continue;

    // Approval-flow receipts are audit records, not canonical materialized
    // receipts.  Their decision vocabulary is approved/rejected, whereas the
    // canonical receipt chain is deliberately limited to admission verdicts.
    // Including them makes a valid admission receipt chain unreadable merely
    // because a separate action audit happened later in the same workspace.
    if (receipt.receiptKind === 'reviewed_action_receipt'
      || receipt.receiptKind === 'blocked_action_receipt') continue;

    const receiptId = trimText(receipt.receiptId);
    if (!receiptId || seen.has(receiptId)) continue;
    seen.add(receiptId);
    const classification = classifyRawMaterializedReceipt(receipt);
    entries.push({
      receipt: clone(receipt),
      auditEvent: publicAuditRef(event),
      classification,
    });
  }

  return entries;
}

function listMaterializedReceiptEntries(source, filters = {}) {
  return collectMaterializedReceiptEntries(source, filters).map(({ receipt, auditEvent }) => ({
    receipt,
    auditEvent,
  }));
}

function inferMaterializedWorkspaceId(entries, filters = {}) {
  const requested = trimText(filters.workspaceId);
  if (requested) return requested;
  const workspaceIds = new Set(entries
    .map((entry) => trimText(entry.receipt?.workspaceId) || trimText(entry.auditEvent?.workspaceId))
    .filter(Boolean));
  return workspaceIds.size === 1 ? [...workspaceIds][0] : null;
}

function inferReceiptFamily(entries) {
  const families = new Set();
  for (const entry of entries) {
    try {
      families.add(classifyReceiptFamily(receiptToCanonicalPayload(entry.receipt, entry.classification)));
    } catch (_) {
      return null;
    }
  }
  return families.size === 1 ? [...families][0] : null;
}

module.exports = {
  collectMaterializedReceiptEntries,
  inferMaterializedWorkspaceId,
  inferReceiptFamily,
  listMaterializedReceiptEntries,
  receiptToCanonicalPayload,
  trimText,
};
