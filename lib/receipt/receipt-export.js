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
const { validateReceiptChain } = require('./receipt-chain');

const RECEIPT_BUNDLE_SCHEMA_VERSION = 'v4-receipt-bundle-v1';

/** Export a chained receipt sequence as a hash-sealed, portable bundle. */
function exportReceiptBundle(chainedReceipts, opts = {}) {
  if (!Array.isArray(chainedReceipts)) {
    throw new TypeError('exportReceiptBundle requires an array of chained receipts');
  }
  const receipts = chainedReceipts.map((r) => ({ ...r }));
  const bundleHash = sha256Hex(stableStringify(receipts));
  return {
    schemaVersion: RECEIPT_BUNDLE_SCHEMA_VERSION,
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
  const chainValidation = validateReceiptChain(bundle.receipts, opts);
  return {
    valid: bundleHashValid && chainValidation.valid,
    bundleHashValid,
    chainValidation,
  };
}

module.exports = {
  RECEIPT_BUNDLE_SCHEMA_VERSION,
  exportReceiptBundle,
  verifyExportedBundle,
};
