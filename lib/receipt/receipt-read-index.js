'use strict';

/**
 * V4-PR2.6 - Receipt Materialization / Read Index.
 *
 * Reads only full receipt objects already materialized into the audit/log
 * path. It never synthesizes a receipt from query state or generates a
 * replacement receiptId.
 */

const { buildCanonicalReceiptPayload } = require('./canonical-receipt');
const {
  buildCanonicalReceiptPayloadV2,
  classifyRawMaterializedReceipt,
} = require('./canonical-receipt-v2');
const { appendReceiptToChain, validateReceiptChain } = require('./receipt-chain');
const { exportReceiptBundle } = require('./receipt-export');
const { validateV4Chain, V4_RECEIPT_ERROR_CODES } = require('./v4-receipt-family');
const { toCanonicalVerdict } = require('../verdict/action-verdict');

const { isPlainObject } = require('../is-plain-object');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

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

function collectMaterializedReceiptEntries(source, filters = {}) {
  const workspaceId = trimText(filters.workspaceId);
  const events = getAuditEvents(source, workspaceId ? { workspaceId } : {});
  const seen = new Set();
  const entries = [];

  for (const event of events) {
    const receipt = event && event.details && event.details.receipt;
    // A malformed object still needs an INVALID_RECEIPT response when its id
    // is requested. It must not silently disappear as NOT_FOUND just because
    // the shared boundary predicate rejected an inherited or exotic record.
    if (!isReceiptCandidate(receipt)) continue;

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

function buildMaterializedReceiptChainFromEntries(entries) {
  const chain = [];
  let previousReceiptHash;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const payload = receiptToCanonicalPayload(entry.receipt, entry.classification);
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

  const chainStatus = chain.some((record) => record.schemaVersion === 'v4-receipt-v2')
    ? validateV4Chain(chain)
    : validateReceiptChain(chain);
  return {
    ok: chainStatus.valid,
    status: chainStatus.valid ? 'valid' : 'invalid',
    chain,
    entries,
    chainStatus,
  };
}

function buildMaterializedReceiptChain(source, filters = {}) {
  return buildMaterializedReceiptChainFromEntries(
    collectMaterializedReceiptEntries(source, filters),
  );
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

  const entries = collectMaterializedReceiptEntries(source, filters);
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
    canonicalPayload = receiptToCanonicalPayload(entry.receipt, entry.classification);
  } catch (error) {
    return {
      ok: false,
      status: 'invalid',
      receiptId: id,
      receipt: clone(entry.receipt),
      auditEvent: entry.auditEvent,
      error: {
        code: 'INVALID_RECEIPT',
        ...(error.causeCode ? { causeCode: error.causeCode } : {}),
        message: error.message,
      },
    };
  }

  const chainResult = buildMaterializedReceiptChainFromEntries(entries);
  const chainedReceipt = chainResult.chain.find((record) => record.receiptId === id) || null;
  const forensics = {
    receiptId: id,
    receipt: clone(entry.receipt),
    canonicalPayload,
    chainedReceipt,
    auditEvent: entry.auditEvent,
    chainValidation: chainResult.chainStatus,
  };

  // A receipt is only as authoritative as the transcript it sits in. Returning
  // ok:true here made chain integrity advisory metadata that callers following
  // the primary ok/status contract never saw -- the viewer read `ok` and
  // rendered "Canonical receipt observed." over a broken chain (#766).
  //
  // Reading such a receipt is still useful for working out what went wrong, so
  // the payload is kept; it is the *status* that refuses to call it found. A
  // caller that wants the forensic copy has to look past ok:false to get it.
  if (!chainResult.chainStatus.valid) {
    return {
      ...forensics,
      ok: false,
      status: 'chain_invalid',
      authoritative: false,
      chainStatus: 'invalid',
      error: {
        code: 'INVALID_RECEIPT_CHAIN',
        message: chainResult.chainStatus.message
          || chainResult.chainStatus.reason
          || 'materialized receipt chain is invalid',
      },
    };
  }

  return {
    ...forensics,
    ok: true,
    status: 'found',
    authoritative: true,
    chainStatus: 'valid',
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
