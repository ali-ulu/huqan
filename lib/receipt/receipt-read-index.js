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
const {
  GENESIS_PREVIOUS_HASH,
  appendReceiptToChain,
  validateReceiptChain,
} = require('./receipt-chain');
const { exportReceiptBundle, verifyExportedBundle } = require('./receipt-export');
const { validateV4Chain, V4_RECEIPT_ERROR_CODES } = require('./v4-receipt-family');
const { toCanonicalVerdict } = require('../verdict/action-verdict');
const {
  AUDIT_EVENT_DETAILS_LIMIT_CODE,
  iterateAuditEventsBounded,
} = require('../audit-log');
const {
  SIZE_LIMIT_CODE,
  measureJsonUtf8Bytes,
} = require('../json-utf8-size');

const MAX_RECEIPTS = 1024;
const MAX_SERIALIZED_BUNDLE_BYTES = 2 * 1024 * 1024;

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
    if (!isPlainObject(receipt)) continue;

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

function buildMaterializedReceiptChain(source, filters = {}) {
  const entries = collectMaterializedReceiptEntries(source, filters);
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

function boundedFailure(status, code, message, extra = {}) {
  return {
    ok: false,
    status,
    error: { code, message, ...extra },
  };
}

function boundedOption(value, hardMax, name) {
  const resolved = value === undefined ? hardMax : value;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > hardMax) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${hardMax}`);
  }
  return resolved;
}

function boundedWorkspace(opts) {
  if (!Object.prototype.hasOwnProperty.call(opts, 'workspaceId') || opts.workspaceId === undefined) {
    return 'default';
  }
  return opts.workspaceId === 'default' ? 'default' : null;
}

function sizeFailure(maxSerializedBundleBytes, details = {}) {
  return boundedFailure(
    'limit_exceeded',
    'MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED',
    `serialized receipt bundle exceeds ${maxSerializedBundleBytes} bytes`,
    { maxBytes: maxSerializedBundleBytes, ...details },
  );
}

function exportMaterializedReceiptBundleBounded(source, opts = {}) {
  const workspaceId = boundedWorkspace(opts);
  if (!workspaceId) {
    return boundedFailure(
      'invalid_request',
      'WORKSPACE_NOT_ALLOWED',
      'bounded receipt export supports only the exact canonical default workspace',
    );
  }

  const maxReceipts = boundedOption(opts.maxReceipts, MAX_RECEIPTS, 'maxReceipts');
  const maxSerializedBundleBytes = boundedOption(
    opts.maxSerializedBundleBytes,
    MAX_SERIALIZED_BUNDLE_BYTES,
    'maxSerializedBundleBytes',
  );
  const seen = new Set();
  const chain = [];
  let previousReceiptHash;
  let receiptsArrayBytes = 2;

  try {
    const events = iterateAuditEventsBounded(
      source,
      { workspaceId },
      { maxDetailsBytes: maxSerializedBundleBytes },
    );

    for (const event of events) {
      const receipt = event && event.details && event.details.receipt;
      if (!isPlainObject(receipt)) continue;

      const receiptId = trimText(receipt.receiptId);
      if (!receiptId || seen.has(receiptId)) continue;
      seen.add(receiptId);
      if (seen.size > maxReceipts) {
        return boundedFailure(
          'limit_exceeded',
          'MAX_RECEIPTS_EXCEEDED',
          `receipt bundle exceeds ${maxReceipts} receipts`,
          { maxReceipts, observedReceipts: seen.size },
        );
      }

      let payload;
      try {
        const classification = classifyRawMaterializedReceipt(receipt);
        payload = receiptToCanonicalPayload(receipt, classification);
        const previous = previousReceiptHash || GENESIS_PREVIOUS_HASH;
        measureJsonUtf8Bytes(
          { ...payload, previousReceiptHash: previous },
          { maxBytes: maxSerializedBundleBytes },
        );
      } catch (error) {
        if (error?.code === SIZE_LIMIT_CODE) {
          return sizeFailure(maxSerializedBundleBytes, { observedBytes: error.bytes });
        }
        return boundedFailure(
          'invalid',
          'INVALID_RECEIPT',
          error?.message || 'materialized receipt is invalid',
          error?.causeCode ? { causeCode: error.causeCode } : {},
        );
      }

      const chained = appendReceiptToChain(payload, previousReceiptHash);
      let recordBytes;
      try {
        recordBytes = measureJsonUtf8Bytes(chained, { maxBytes: maxSerializedBundleBytes });
      } catch (error) {
        if (error?.code === SIZE_LIMIT_CODE) {
          return sizeFailure(maxSerializedBundleBytes, { observedBytes: error.bytes });
        }
        return boundedFailure('invalid', 'INVALID_RECEIPT', error?.message || 'receipt cannot be serialized');
      }

      const nextArrayBytes = receiptsArrayBytes + (chain.length > 0 ? 1 : 0) + recordBytes;
      if (nextArrayBytes > maxSerializedBundleBytes) {
        return sizeFailure(maxSerializedBundleBytes, { observedBytes: nextArrayBytes });
      }
      chain.push(chained);
      receiptsArrayBytes = nextArrayBytes;
      previousReceiptHash = chained.receiptHash;
    }
  } catch (error) {
    if (error?.code === AUDIT_EVENT_DETAILS_LIMIT_CODE || error?.code === SIZE_LIMIT_CODE) {
      return sizeFailure(maxSerializedBundleBytes, { observedBytes: error.bytes });
    }
    return boundedFailure(
      'read_error',
      error?.code || 'BOUNDED_AUDIT_READ_FAILED',
      error?.message || 'bounded audit read failed',
    );
  }

  const chainStatus = chain.some((record) => record.schemaVersion === 'v4-receipt-v2')
    ? validateV4Chain(chain)
    : validateReceiptChain(chain);
  if (!chainStatus.valid) {
    return {
      ...boundedFailure(
        'invalid',
        'INVALID_RECEIPT_CHAIN',
        chainStatus.message || chainStatus.reason || chainStatus.code || 'receipt chain is invalid',
      ),
      chainStatus,
    };
  }

  let bundle;
  try {
    bundle = exportReceiptBundle(chain, {
      workspaceId,
      ...(opts.exportedAt === undefined ? {} : { exportedAt: opts.exportedAt }),
    });
  } catch (error) {
    return boundedFailure(
      'invalid',
      error?.code || 'INVALID_RECEIPT_CHAIN',
      error?.message || 'receipt bundle export failed',
    );
  }

  let verification;
  try {
    verification = verifyExportedBundle(bundle);
  } catch (error) {
    return boundedFailure(
      'invalid',
      'BUNDLE_VERIFICATION_FAILED',
      error?.message || 'receipt bundle verification failed',
    );
  }
  if (!verification.valid) {
    return boundedFailure(
      'invalid',
      'BUNDLE_VERIFICATION_FAILED',
      'receipt bundle verification failed',
    );
  }

  let serializedBytes;
  try {
    serializedBytes = measureJsonUtf8Bytes(bundle, { maxBytes: maxSerializedBundleBytes });
  } catch (error) {
    if (error?.code === SIZE_LIMIT_CODE) {
      return sizeFailure(maxSerializedBundleBytes, { observedBytes: error.bytes });
    }
    return boundedFailure(
      'invalid',
      'BUNDLE_SERIALIZATION_FAILED',
      error?.message || 'receipt bundle cannot be serialized',
    );
  }

  return {
    ok: true,
    status: 'exported',
    bundle,
    serializedBytes,
    chainStatus,
    verification,
  };
}

module.exports = {
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  buildMaterializedReceiptChain,
  exportMaterializedReceiptBundle,
  exportMaterializedReceiptBundleBounded,
  listMaterializedReceiptEntries,
  readReceiptById,
  receiptToCanonicalPayload,
};
