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
const { signReceiptBundle } = require('./signed-bundle');
const { verifyReceiptBundleSignature } = require('./signed-bundle');
const {
  V4_RECEIPT_ERROR_CODES,
  classifyReceiptFamily,
  validateV4Chain,
} = require('./v4-receipt-family');

const RECEIPT_BUNDLE_SCHEMA_VERSION = 'v4-receipt-bundle-v1';
const RECEIPT_BUNDLE_V2_SCHEMA_VERSION = 'v4-receipt-bundle-v2';

/**
 * Identifier of the canonical bundle-hash input (issues #735, #767).
 *
 * The original seal hashed `receipts` alone, leaving the envelope —
 * schemaVersion, workspaceId, exportedAt, receiptCount — outside the
 * authenticated payload. A bundle could therefore be relabelled as another
 * workspace or export time, or declare a false receipt count, and still verify
 * as valid, because only the receipt bytes were covered. Recipients who read
 * that envelope as provenance were trusting unauthenticated claims.
 *
 * Naming the seal in the envelope is what lets an external verifier reproduce
 * the hash input exactly, and lets a verifier tell a sealed bundle from a
 * legacy one without guessing.
 */
const BUNDLE_SEAL_VERSION = 'huqan-bundle-seal-v2';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * The exact bytes the bundle hash commits to. Key order is irrelevant —
 * stableStringify sorts — but the field set is normative: anything a consumer
 * may treat as authoritative has to be in here.
 */
function canonicalBundleSealPayload(bundle) {
  return {
    sealVersion: BUNDLE_SEAL_VERSION,
    schemaVersion: bundle.schemaVersion,
    workspaceId: bundle.workspaceId,
    exportedAt: bundle.exportedAt,
    receiptCount: bundle.receiptCount,
    receipts: bundle.receipts,
  };
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
  const envelope = {
    sealVersion: BUNDLE_SEAL_VERSION,
    schemaVersion,
    workspaceId: opts.workspaceId || 'default',
    exportedAt: opts.exportedAt || new Date().toISOString(),
    receiptCount: receipts.length,
    receipts,
  };
  const bundle = {
    ...envelope,
    bundleHash: sha256Hex(stableStringify(canonicalBundleSealPayload(envelope))),
    receipts,
  };
  if (opts.signing) {
    const signature = signReceiptBundle(bundle, opts.signing);
    if (!signature) throw codedError('BUNDLE_SIGNATURE_FAILED', 'receipt bundle signature could not be created');
    bundle.bundleSignature = signature;
  }
  return bundle;
}

/**
 * Independently re-verify an exported bundle: recompute the bundle hash from
 * the bundle's own canonical seal payload (detecting any post-export tampering
 * with the receipts *or* the envelope), check the declared receipt count
 * against the array, then run full chain validation. Takes only the bundle —
 * no access to whatever in-memory state originally produced it.
 *
 * Legacy bundles carry no `sealVersion`; their envelope was never
 * authenticated, so they verify only when the caller passes
 * `allowUnsealedEnvelope: true`, and the result reports
 * `envelopeAuthenticated: false` so such a caller knows the envelope metadata
 * is presentation only (#735, #767).
 */
function verifyExportedBundle(bundle, opts = {}) {
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.receipts)) {
    throw new TypeError('verifyExportedBundle requires an exported receipt bundle');
  }

  const envelopeSealed = bundle.sealVersion === BUNDLE_SEAL_VERSION;
  const recomputedBundleHash = envelopeSealed
    ? sha256Hex(stableStringify(canonicalBundleSealPayload(bundle)))
    // Legacy bundles predate the envelope seal and committed to receipts only.
    : sha256Hex(stableStringify(bundle.receipts));
  const bundleHashValid = recomputedBundleHash === bundle.bundleHash;

  // Self-consistency, checked for every seal version: a declared count that
  // disagrees with the array is a defect regardless of what is authenticated.
  const receiptCountValid = bundle.receiptCount === undefined
    || bundle.receiptCount === bundle.receipts.length;

  const hasV2 = bundle.receipts.some((record) => record?.schemaVersion === 'v4-receipt-v2');
  const expectedBundleVersion = hasV2 ? RECEIPT_BUNDLE_V2_SCHEMA_VERSION : RECEIPT_BUNDLE_SCHEMA_VERSION;
  const bundleVersionValid = bundle.schemaVersion === expectedBundleVersion;
  const familyValid = bundle.receipts.every((record) => classifyReceiptFamily(record) === 'v4');
  const chainValidation = familyValid
    ? validateV4Chain(bundle.receipts, opts)
    : { valid: false, brokenAt: 0, code: V4_RECEIPT_ERROR_CODES.BUNDLE_MIXED_FAMILY };

  // A legacy bundle's envelope is unauthenticated, so it is only acceptable
  // when the caller explicitly says it will not trust that envelope. Silently
  // accepting one would keep exactly the property these issues are about.
  const sealVersionAcceptable = envelopeSealed || opts.allowUnsealedEnvelope === true;
  const signature = bundle.bundleSignature;
  const signed = signature !== undefined;
  const publicKey = signed && typeof opts.resolveBundleSigningKey === 'function'
    ? opts.resolveBundleSigningKey(signature?.keyReference)
    : null;
  const signatureValid = signed
    ? verifyReceiptBundleSignature(bundle, signature, publicKey)
    : false;
  const signatureStatus = signed ? (signatureValid ? 'signed' : 'invalid') : 'unsigned';
  const signatureAcceptable = !signed || signatureValid;

  return {
    valid: bundleHashValid && bundleVersionValid && receiptCountValid
      && sealVersionAcceptable && chainValidation.valid && signatureAcceptable,
    bundleHashValid,
    bundleVersionValid,
    receiptCountValid,
    sealVersionAcceptable,
    /** False means schemaVersion/workspaceId/exportedAt/receiptCount are NOT authenticated. */
    envelopeAuthenticated: envelopeSealed,
    sealVersion: bundle.sealVersion || null,
    signatureStatus,
    signatureValid,
    chainValidation,
  };
}

module.exports = {
  BUNDLE_SEAL_VERSION,
  RECEIPT_BUNDLE_SCHEMA_VERSION,
  RECEIPT_BUNDLE_V2_SCHEMA_VERSION,
  canonicalBundleSealPayload,
  exportReceiptBundle,
  verifyExportedBundle,
};
