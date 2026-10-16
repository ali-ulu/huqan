'use strict';

/**
 * V4-B3 — Workbench receipt bundle export owner.
 *
 * Owns the three decisions the route must not make: which workspace may be
 * read, that both ceilings are enforced during the read rather than after it,
 * and that nothing leaves this module unless `verifyExportedBundle()` accepted
 * it first.
 *
 * The bounded source seam (V4-B3A) does the streaming read, the exact UTF-8
 * byte accounting and the verification. This module binds the canonical
 * workspace before that read starts and reshapes the seam's outcome into a
 * stable, leak-free body. It does not define a receipt format, redact any
 * field, or become a second export owner.
 */

const {
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  exportMaterializedReceiptBundleBounded,
} = require('../receipt/bounded-receipt-export');

const CANONICAL_WORKSPACE_ID = 'default';

/**
 * Public error text, keyed by code.
 *
 * Underlying error messages are never forwarded: a read failure can carry a
 * driver string or a row fragment, and the contract forbids raw exception or
 * private Graph content in any response.
 */
const PUBLIC_ERROR_MESSAGES = Object.freeze({
  WORKSPACE_NOT_ALLOWED: 'receipt bundle export supports only the canonical default workspace',
  MAX_RECEIPTS_EXCEEDED: 'receipt bundle exceeds the receipt ceiling',
  MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED: 'receipt bundle exceeds the serialized byte ceiling',
  INVALID_RECEIPT: 'a stored receipt is not a valid canonical receipt',
  INVALID_RECEIPT_CHAIN: 'stored receipt chain is invalid',
  BUNDLE_VERIFICATION_FAILED: 'exported receipt bundle failed verification',
  BUNDLE_SERIALIZATION_FAILED: 'receipt bundle could not be serialized within the byte ceiling',
  RECEIPT_BUNDLE_READ_FAILED: 'receipt source could not be read',
});

const NUMERIC_ERROR_FIELDS = Object.freeze([
  'maxReceipts',
  'observedReceipts',
  'maxBytes',
  'bytesAtFailure',
]);

const LIMITS = Object.freeze({
  maxReceipts: MAX_RECEIPTS,
  maxSerializedBundleBytes: MAX_SERIALIZED_BUNDLE_BYTES,
});

/**
 * Bind the canonical workspace before any read.
 *
 * Exact string match only. The value is not trimmed, lower-cased or coerced
 * first, matching the boundary PR #301 repaired for the WB2 audit source: a
 * padded or differently cased value is a different value, not a default one.
 * `undefined` means the caller omitted the parameter; an empty string means the
 * caller supplied a blank one, and only the first is canonical.
 */
function resolveCanonicalWorkspace(workspaceId) {
  if (workspaceId === undefined) return CANONICAL_WORKSPACE_ID;
  if (workspaceId === CANONICAL_WORKSPACE_ID) return CANONICAL_WORKSPACE_ID;
  return null;
}

function publicError(code, extra = {}) {
  const error = {
    code,
    message: PUBLIC_ERROR_MESSAGES[code] || 'receipt bundle export failed',
  };
  for (const field of NUMERIC_ERROR_FIELDS) {
    if (Number.isSafeInteger(extra[field])) error[field] = extra[field];
  }
  return error;
}

function failure(status, code, extra) {
  return { ok: false, status, workspaceId: CANONICAL_WORKSPACE_ID, error: publicError(code, extra), limits: LIMITS };
}

/**
 * Map a bounded-seam outcome onto this surface's vocabulary.
 *
 * `invalid` covers every way the stored data failed to produce a bundle the
 * verifier accepted — malformed receipt, broken chain, failed verification.
 * They share one HTTP status by design: from the caller's side the resource is
 * in conflict with itself, and distinguishing them further would describe
 * internal state.
 */
function mapBoundedOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return failure('read_error', 'RECEIPT_BUNDLE_READ_FAILED');
  }
  if (outcome.ok === true) {
    return {
      ok: true,
      status: 'exported',
      workspaceId: CANONICAL_WORKSPACE_ID,
      receiptCount: outcome.bundle?.receiptCount ?? 0,
      serializedBytes: outcome.serializedBytes,
      bundleHash: outcome.bundle?.bundleHash || '',
      verified: outcome.verification?.valid === true,
      bundle: outcome.bundle,
      limits: LIMITS,
    };
  }

  const code = outcome.error?.code;
  const extra = outcome.error || {};
  if (outcome.status === 'invalid_request') return failure('invalid_request', 'WORKSPACE_NOT_ALLOWED');
  if (outcome.status === 'limit_exceeded') {
    return failure('limit_exceeded',
      code === 'MAX_RECEIPTS_EXCEEDED' ? 'MAX_RECEIPTS_EXCEEDED' : 'MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED',
      extra);
  }
  if (outcome.status === 'invalid') {
    const known = PUBLIC_ERROR_MESSAGES[code] ? code : 'INVALID_RECEIPT_CHAIN';
    return failure('invalid', known, extra);
  }
  return failure('read_error', 'RECEIPT_BUNDLE_READ_FAILED');
}

/**
 * Export the canonical workspace's receipt bundle, bounded and verified.
 *
 * `exportBundle` exists so a caller can prove the failure branches — including
 * a bundle that fails verification, which the real seam cannot produce on
 * demand. It defaults to the real bounded seam; production callers never pass
 * it.
 */
function exportWorkbenchReceiptBundle({ workspaceId, source, exportBundle, exportedAt } = {}) {
  const canonical = resolveCanonicalWorkspace(workspaceId);
  if (canonical === null) {
    return failure('invalid_request', 'WORKSPACE_NOT_ALLOWED');
  }
  if (!source || typeof source !== 'object') {
    return failure('read_error', 'RECEIPT_BUNDLE_READ_FAILED');
  }

  const runExport = typeof exportBundle === 'function'
    ? exportBundle
    : exportMaterializedReceiptBundleBounded;

  let outcome;
  try {
    outcome = runExport(source, {
      workspaceId: canonical,
      maxReceipts: MAX_RECEIPTS,
      maxSerializedBundleBytes: MAX_SERIALIZED_BUNDLE_BYTES,
      ...(exportedAt === undefined ? {} : { exportedAt }),
    });
  } catch (_error) {
    // The seam reports read failures as values; a thrown error is unexpected
    // and its message is not ours to publish.
    return failure('read_error', 'RECEIPT_BUNDLE_READ_FAILED');
  }

  const mapped = mapBoundedOutcome(outcome);
  if (mapped.ok === true && mapped.verified !== true) {
    // Defence in depth: an unverified bundle never leaves this module, whatever
    // the seam claimed.
    return failure('invalid', 'BUNDLE_VERIFICATION_FAILED');
  }
  return mapped;
}

module.exports = {
  CANONICAL_WORKSPACE_ID,
  MAX_RECEIPTS,
  MAX_SERIALIZED_BUNDLE_BYTES,
  exportWorkbenchReceiptBundle,
};
