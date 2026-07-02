'use strict';

/**
 * V4-PR2.6 - Receipt Materialization / Read Index.
 *
 * Reads only full receipt objects already materialized into the audit/log
 * path. It never synthesizes a receipt from query state or generates a
 * replacement receiptId.
 */

const { buildCanonicalReceiptPayload } = require('./canonical-receipt');
const { appendReceiptToChain, validateReceiptChain } = require('./receipt-chain');
const { exportReceiptBundle } = require('./receipt-export');
const { toCanonicalVerdict } = require('../verdict/action-verdict');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
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

function receiptToCanonicalPayload(receipt) {
  if (!isPlainObject(receipt)) {
    throw new TypeError('receiptToCanonicalPayload requires a materialized receipt object');
  }
  const verdict = toCanonicalVerdict('admission', trimText(receipt.decision));
  return buildCanonicalReceiptPayload(receipt, { verdict });
}

function listMaterializedReceiptEntries(source, filters = {}) {
  const workspaceId = trimText(filters.workspaceId);
  const events = getAuditEvents(source, workspaceId ? { workspaceId } : {});
  const seen = new Set();
  const entries = [];

  for (const event of events) {
    const receipt = event && event.details && event.details.receipt;
    if (!isPlainObject(receipt)) continue;

    const receiptId = trimText(receipt.receiptId);
    if (!receiptId || seen.has(receiptId)) continue;
    seen.add(receiptId);
    entries.push({
      receipt: clone(receipt),
      auditEvent: publicAuditRef(event),
    });
  }

  return entries;
}

function buildMaterializedReceiptChain(source, filters = {}) {
  const entries = listMaterializedReceiptEntries(source, filters);
  const chain = [];
  let previousReceiptHash;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const payload = receiptToCanonicalPayload(entry.receipt);
      const chained = appendReceiptToChain(payload, previousReceiptHash);
      chain.push(chained);
      previousReceiptHash = chained.receiptHash;
    } catch (error) {
      return {
        ok: false,
        status: 'invalid',
        chain: [],
        entries,
        chainStatus: {
          valid: false,
          brokenAt: i,
          reason: 'invalid_materialized_receipt',
          message: error.message,
        },
      };
    }
  }

  const chainStatus = validateReceiptChain(chain);
  return {
    ok: chainStatus.valid,
    status: chainStatus.valid ? 'valid' : 'invalid',
    chain,
    entries,
    chainStatus,
  };
}

function readReceiptById(source, receiptId, filters = {}) {
  const id = trimText(receiptId);
  if (!id) {
    return {
      ok: false,
      status: 'invalid_request',
      receiptId: '',
      error: {
        code: 'RECEIPT_ID_REQUIRED',
        message: 'receiptId is required and must be non-empty',
      },
    };
  }

  const entries = listMaterializedReceiptEntries(source, filters);
  const entry = entries.find((candidate) => trimText(candidate.receipt.receiptId) === id);
  if (!entry) {
    return {
      ok: false,
      status: 'not_found',
      receiptId: id,
      error: {
        code: 'NOT_FOUND',
        message: 'receipt was not found in the materialized read index',
      },
    };
  }

  let canonicalPayload;
  try {
    canonicalPayload = receiptToCanonicalPayload(entry.receipt);
  } catch (error) {
    return {
      ok: false,
      status: 'invalid',
      receiptId: id,
      receipt: clone(entry.receipt),
      auditEvent: entry.auditEvent,
      error: {
        code: 'INVALID_RECEIPT',
        message: error.message,
      },
    };
  }

  const chainResult = buildMaterializedReceiptChain(source, filters);
  const chainedReceipt = chainResult.chain.find((record) => record.receiptId === id) || null;
  return {
    ok: true,
    status: 'found',
    receiptId: id,
    receipt: clone(entry.receipt),
    canonicalPayload,
    chainedReceipt,
    auditEvent: entry.auditEvent,
    chainStatus: chainResult.chainStatus.valid ? 'valid' : 'invalid',
    chainValidation: chainResult.chainStatus,
  };
}

function exportMaterializedReceiptBundle(source, opts = {}) {
  const chainResult = buildMaterializedReceiptChain(source, opts);
  if (!chainResult.ok) {
    return {
      ok: false,
      status: 'invalid',
      error: {
        code: 'INVALID_RECEIPT_CHAIN',
        message: chainResult.chainStatus.message || chainResult.chainStatus.reason || 'receipt chain is invalid',
      },
      chainStatus: chainResult.chainStatus,
    };
  }
  return {
    ok: true,
    status: 'exported',
    bundle: exportReceiptBundle(chainResult.chain, opts),
    chainStatus: chainResult.chainStatus,
  };
}

module.exports = {
  buildMaterializedReceiptChain,
  exportMaterializedReceiptBundle,
  listMaterializedReceiptEntries,
  readReceiptById,
  receiptToCanonicalPayload,
};
