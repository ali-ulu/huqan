'use strict';

const { readReceiptById } = require('../receipt/receipt-read-index');

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sourceMeta(extra = {}) {
  return {
    kind: 'trust_receipt_read_index',
    readOnly: true,
    ...extra,
  };
}

function missingFieldsFor(result) {
  const optionalFields = [
    'reason',
    'actor',
    'action',
    'tool',
    'claim',
    'traceId',
    'timestamp',
  ];
  return optionalFields.filter((field) => trimText(result[field]) === '');
}

function normalizeFoundReceipt(readResult) {
  const receipt = clone(readResult.receipt);
  const canonicalPayload = clone(readResult.canonicalPayload);
  const chainedReceipt = clone(readResult.chainedReceipt);
  const auditEvent = clone(readResult.auditEvent);
  const metadata = receipt && typeof receipt.metadata === 'object' ? receipt.metadata : {};

  const normalized = {
    ok: true,
    status: 'found',
    receiptId: trimText(readResult.receiptId || receipt.receiptId),
    workspaceId: trimText(receipt.workspaceId || canonicalPayload.workspaceId),
    verdict: trimText(canonicalPayload.verdict),
    reason: trimText(canonicalPayload.reason || receipt.reason),
    actor: trimText(canonicalPayload.actor || receipt.actor),
    action: trimText(metadata.action || canonicalPayload.action || receipt.action),
    tool: trimText(metadata.tool || canonicalPayload.tool || receipt.tool),
    claim: trimText(metadata.claim || canonicalPayload.claim || receipt.claim),
    traceId: trimText(metadata.traceId || canonicalPayload.traceId || receipt.traceId),
    timestamp: trimText(canonicalPayload.createdAt || receipt.createdAt || auditEvent.timestamp),
    receipt,
    canonicalPayload,
    chainedReceipt,
    auditEvent,
    chainStatus: readResult.chainStatus || null,
    chainValidation: clone(readResult.chainValidation) || null,
    missingFields: [],
    source: sourceMeta({ chainValidated: readResult.chainStatus === 'valid' }),
  };
  normalized.missingFields = missingFieldsFor(normalized);
  return normalized;
}

function inspectTrustReceipt(options = {}) {
  const receiptId = trimText(options.receiptId);
  if (!receiptId) {
    return {
      ok: false,
      status: 'invalid_request',
      reason: 'receiptId_required',
      receiptId: null,
      missingFields: ['receiptId'],
      source: sourceMeta(),
    };
  }

  const source = options.source || options.graph;
  if (!source) {
    return {
      ok: false,
      status: 'read_error',
      reason: 'receipt_source_required',
      receiptId,
      missingFields: ['source'],
      source: sourceMeta(),
    };
  }

  const workspaceId = trimText(options.workspaceId);
  const filters = workspaceId ? { workspaceId } : {};
  const read = options.readReceipt
    ? options.readReceipt(source, receiptId, filters)
    : readReceiptById(source, receiptId, filters);

  if (!read || typeof read !== 'object') {
    return {
      ok: false,
      status: 'read_error',
      reason: 'receipt_read_failed',
      receiptId,
      missingFields: [],
      source: sourceMeta(),
    };
  }

  if (read.ok) {
    return normalizeFoundReceipt(read);
  }

  if (read.status === 'invalid_request') {
    return {
      ok: false,
      status: 'invalid_request',
      reason: 'receiptId_required',
      receiptId: null,
      missingFields: ['receiptId'],
      source: sourceMeta(),
    };
  }

  if (read.status === 'not_found') {
    return {
      ok: false,
      status: 'not_found',
      reason: 'receipt_not_found',
      receiptId,
      missingFields: [],
      source: sourceMeta(),
    };
  }

  return {
    ok: false,
    status: 'read_error',
    reason: read.error && read.error.message ? read.error.message : 'receipt_read_failed',
    receiptId,
    missingFields: [],
    source: sourceMeta(),
  };
}

module.exports = {
  inspectTrustReceipt,
};
