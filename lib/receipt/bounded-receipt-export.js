'use strict';

const { GENESIS_PREVIOUS_HASH, appendReceiptToChain } = require('./receipt-chain');
const { exportReceiptBundle, verifyExportedBundle } = require('./receipt-export');
const { validateV4Chain } = require('./v4-receipt-family');
const { receiptToCanonicalPayload } = require('./receipt-read-index');
const {
  AUDIT_EVENT_DETAILS_LIMIT_CODE,
  iterateAuditEventsBounded,
} = require('../audit-bounded-read');
const { SIZE_LIMIT_CODE, measureJsonUtf8Bytes } = require('../json-utf8-size');

const MAX_RECEIPTS = 1024;
const MAX_SERIALIZED_BUNDLE_BYTES = 2 * 1024 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function failure(status, code, message, extra = {}) {
  return { ok: false, status, error: { code, message, ...extra } };
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

function sizeFailure(maxBytes, extra = {}) {
  return failure('limit_exceeded', 'MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED',
    `serialized receipt bundle exceeds ${maxBytes} bytes`, { maxBytes, ...extra });
}

function measureWithin(value, maxBytes) {
  try {
    return { ok: true, bytes: measureJsonUtf8Bytes(value, { maxBytes }) };
  } catch (error) {
    if (error?.code === SIZE_LIMIT_CODE) {
      return { ok: false, result: sizeFailure(maxBytes, { bytesAtFailure: error.bytes }) };
    }
    return { ok: false, result: failure('invalid', 'BUNDLE_SERIALIZATION_FAILED', error.message) };
  }
}

function exportMaterializedReceiptBundleBounded(source, opts = {}) {
  const workspaceId = boundedWorkspace(opts);
  if (!workspaceId) {
    return failure('invalid_request', 'WORKSPACE_NOT_ALLOWED',
      'bounded receipt export supports only the exact canonical default workspace');
  }
  const maxReceipts = boundedOption(opts.maxReceipts, MAX_RECEIPTS, 'maxReceipts');
  const maxBytes = boundedOption(opts.maxSerializedBundleBytes,
    MAX_SERIALIZED_BUNDLE_BYTES, 'maxSerializedBundleBytes');
  const seen = new Set();
  const chain = [];
  let previousReceiptHash;
  let receiptArrayBytes = 2;

  try {
    const events = iterateAuditEventsBounded(source, { workspaceId }, { maxDetailsBytes: maxBytes });
    for (const event of events) {
      const receipt = event?.details?.receipt;
      if (!isPlainObject(receipt)) continue;
      const receiptId = trimText(receipt.receiptId);
      if (!receiptId || seen.has(receiptId)) continue;
      seen.add(receiptId);
      if (seen.size > maxReceipts) {
        return failure('limit_exceeded', 'MAX_RECEIPTS_EXCEEDED',
          `receipt bundle exceeds ${maxReceipts} receipts`,
          { maxReceipts, observedReceipts: seen.size });
      }

      let payload;
      try {
        payload = receiptToCanonicalPayload(receipt);
      } catch (error) {
        return failure('invalid', 'INVALID_RECEIPT', error.message,
          error?.causeCode ? { causeCode: error.causeCode } : {});
      }

      const previous = previousReceiptHash || GENESIS_PREVIOUS_HASH;
      const hashInputSize = measureWithin({ ...payload, previousReceiptHash: previous }, maxBytes);
      if (!hashInputSize.ok) return hashInputSize.result;

      let chained;
      try {
        chained = appendReceiptToChain(payload, previousReceiptHash);
      } catch (error) {
        return failure('invalid', 'INVALID_RECEIPT', error.message);
      }
      const recordSize = measureWithin(chained, maxBytes);
      if (!recordSize.ok) return recordSize.result;
      const nextArrayBytes = receiptArrayBytes + (chain.length ? 1 : 0) + recordSize.bytes;
      if (nextArrayBytes > maxBytes) {
        return sizeFailure(maxBytes, { bytesAtFailure: nextArrayBytes });
      }
      chain.push(chained);
      receiptArrayBytes = nextArrayBytes;
      previousReceiptHash = chained.receiptHash;
    }
  } catch (error) {
    if (error?.code === AUDIT_EVENT_DETAILS_LIMIT_CODE || error?.code === SIZE_LIMIT_CODE) {
      return sizeFailure(maxBytes, {
        ...(Number.isSafeInteger(error.bytes) ? { bytesAtFailure: error.bytes } : {}),
      });
    }
    return failure('read_error', error?.code || 'BOUNDED_AUDIT_READ_FAILED',
      error?.message || 'bounded audit read failed');
  }

  const chainStatus = validateV4Chain(chain);
  if (!chainStatus.valid) {
    return {
      ...failure('invalid', 'INVALID_RECEIPT_CHAIN',
        chainStatus.code || chainStatus.genericReason || 'receipt chain is invalid'),
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
    return failure('invalid', error?.code || 'INVALID_RECEIPT_CHAIN', error.message);
  }

  let verification;
  try {
    verification = verifyExportedBundle(bundle);
  } catch (error) {
    return failure('invalid', 'BUNDLE_VERIFICATION_FAILED', error.message);
  }
  if (!verification.valid) {
    return failure('invalid', 'BUNDLE_VERIFICATION_FAILED', 'receipt bundle verification failed');
  }

  const finalSize = measureWithin(bundle, maxBytes);
  if (!finalSize.ok) return finalSize.result;
  return {
    ok: true,
    status: 'exported',
    bundle,
    serializedBytes: finalSize.bytes,
    chainStatus,
    verification,
  };
}

module.exports = {
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  exportMaterializedReceiptBundleBounded,
};
