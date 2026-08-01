'use strict';

/**
 * V4-PR2.5 — Trust Receipt Primitive Hardening: audit/export path.
 *
 * Exports a chained receipt sequence as a self-contained, independently
 * re-verifiable bundle. "Independently re-verifiable" means
 * verifyExportedBundle() takes ONLY the exported bundle (no in-memory state,
 * no database access) and can still detect tampering.
 */

const { stableStringify, sha256Hex } = require('./canonical-receipt');
const {
  V4_RECEIPT_ERROR_CODES,
  classifyReceiptFamily,
  validateV4Chain,
} = require('./v4-receipt-family');

const RECEIPT_BUNDLE_SCHEMA_VERSION = 'v4-receipt-bundle-v1';
const RECEIPT_BUNDLE_V2_SCHEMA_VERSION = 'v4-receipt-bundle-v2';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Export a chained receipt sequence as a hash-sealed, portable bundle. */
function exportReceiptBundle(chainedReceipts, opts = {}) {
  if (!Array.isArray(chainedReceipts)) {
    throw new TypeError('exportReceiptBundle requires an array of chained receipts');
  }
  if (chainedReceipts.some((record) => classifyReceiptFamily(record) !== 'v4')) {
    throw codedError(V4_RECEIPT_ERROR_CODES.BUNDLE_MIXED_FAMILY, 'V4 receipt export requires V4-family records only');
  }
  const versionedValidation = validateV4Chain(chainedReceipts);
  if (!versionedValidation.valid) {
    throw codedError(versionedValidation.code || 'INVALID_RECEIPT_CHAIN', 'V4 receipt chain is invalid');
  }
  const receipts = chainedReceipts.map((r) => ({ ...r }));
  const schemaVersion = receipts.some((record) => record.schemaVersion === 'v4-receipt-v2')
    ? RECEIPT_BUNDLE_V2_SCHEMA_VERSION
    : RECEIPT_BUNDLE_SCHEMA_VERSION;
  const bundleHash = sha256Hex(stableStringify(receipts));
  return {
    schemaVersion,
    workspaceId: opts.workspaceId || 'default',
    exportedAt: opts.exportedAt || new Date().toISOString(),
    receiptCount: receipts.length,
    bundleHash,
    receipts,
  };
}

/**
 * Independently re-verify an exported bundle: recompute the bundle hash from
 * its own `receipts` array (detecting any post-export tampering with the
 * bundle itself), then run full chain validation on those receipts
 * (detecting tampering within the chain). Takes only the bundle — no access
 * to whatever in-memory state originally produced it.
 */
function verifyExportedBundle(bundle, opts = {}) {
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.receipts)) {
    throw new TypeError('verifyExportedBundle requires an exported receipt bundle');
  }
  const recomputedBundleHash = sha256Hex(stableStringify(bundle.receipts));
  const bundleHashValid = recomputedBundleHash === bundle.bundleHash;
  const hasV2 = bundle.receipts.some((record) => record?.schemaVersion === 'v4-receipt-v2');
  const expectedBundleVersion = hasV2 ? RECEIPT_BUNDLE_V2_SCHEMA_VERSION : RECEIPT_BUNDLE_SCHEMA_VERSION;
  const bundleVersionValid = bundle.schemaVersion === expectedBundleVersion;
  const familyValid = bundle.receipts.every((record) => classifyReceiptFamily(record) === 'v4');
  const chainValidation = familyValid
    ? validateV4Chain(bundle.receipts, opts)
    : { valid: false, brokenAt: 0, code: V4_RECEIPT_ERROR_CODES.BUNDLE_MIXED_FAMILY };
  return {
    valid: bundleHashValid && bundleVersionValid && chainValidation.valid,
    bundleHashValid,
    bundleVersionValid,
    chainValidation,
  };
}

module.exports = {
  RECEIPT_BUNDLE_SCHEMA_VERSION,
  RECEIPT_BUNDLE_V2_SCHEMA_VERSION,
  exportReceiptBundle,
  verifyExportedBundle,
};
