'use strict';

// #2161: parsing canonical bytes and importing a public receipt, verifying
// checksum, signature, trusted key and bindings before it is accepted.

const { encodeJsonStableV1 } = require('./cryptographic-profile-contract');
const { verifyCryptographicEvidence } = require('./cryptographic-verification-adapter');
const { resolveTrustedKeyState } = require('./trusted-key-resolver');
const { ERROR_CODES, HASH_PATTERN, IMPORT_KEYS, MAX_PUBLIC_RECEIPT_BYTES, PUBLIC_RECEIPT_SIGNATURE_PROFILE, PublicTrustReceiptError, fail } = require('./public-trust-receipt-contract');
const { computePublicReceiptChecksum, signatureProjection, validatePublicReceiptShape, verifyDisclosureBinding, verifySourceBundle } = require('./public-trust-receipt-integrity');
const { deepFreeze, snapshotCanonicalJson, snapshotDataObject } = require('./public-trust-receipt-values');

function parseCanonicalPublicReceiptBytes(input) {
  if (!(Buffer.isBuffer(input) || input instanceof Uint8Array)) {
    fail(ERROR_CODES.NON_CANONICAL, 'public receipt input must be bytes');
  }
  const bytes = Buffer.from(input);
  if (bytes.length < 1 || bytes.length > MAX_PUBLIC_RECEIPT_BYTES) {
    fail(ERROR_CODES.SIZE_LIMIT, 'public receipt exceeds the byte limit');
  }
  let parsed;
  try {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      fail(ERROR_CODES.NON_CANONICAL, 'public receipt is not valid UTF-8');
    }
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof PublicTrustReceiptError) throw error;
    fail(ERROR_CODES.NON_CANONICAL, 'public receipt is not valid JSON');
  }
  let canonical;
  try {
    canonical = encodeJsonStableV1(parsed);
  } catch (_) {
    fail(ERROR_CODES.NON_CANONICAL, 'public receipt cannot be canonically encoded');
  }
  if (!canonical.equals(bytes)) {
    fail(ERROR_CODES.NON_CANONICAL, 'public receipt bytes are not canonical');
  }
  return parsed;
}

function importPublicTrustReceipt(input, options = {}) {
  try {
    const receipt = parseCanonicalPublicReceiptBytes(input);
    const shapeError = validatePublicReceiptShape(receipt);
    if (shapeError) fail(shapeError, 'public receipt shape is invalid');

    // Checksum is deliberately first after structural parsing. No trusted-key
    // record or resolver-controlled value is observed before corruption is
    // rejected.
    if (computePublicReceiptChecksum(receipt) !== receipt.integrity.checksum) {
      fail(ERROR_CODES.CHECKSUM_INVALID, 'public receipt checksum is invalid');
    }

    const root = snapshotDataObject(
      options,
      IMPORT_KEYS,
      new Set(['expectedInternalReceiptHash', 'trustedKeyRecords', 'evaluationTime']),
    );
    if (!root || !HASH_PATTERN.test(root.expectedInternalReceiptHash)) {
      fail(ERROR_CODES.BINDING_MISMATCH, 'an independent internal receipt hash is required');
    }
    if (receipt.binding.internalReceiptHash !== root.expectedInternalReceiptHash) {
      fail(ERROR_CODES.BINDING_MISMATCH, 'internal receipt hash binding does not match');
    }

    let disclosureBinding = 'issuer_asserted';
    if (Object.hasOwn(receipt.binding, 'bundleHash')) {
      let independentlyMatched = false;
      if (Object.hasOwn(root, 'expectedBundleHash')) {
        if (!HASH_PATTERN.test(root.expectedBundleHash)
          || root.expectedBundleHash !== receipt.binding.bundleHash) {
          fail(ERROR_CODES.BUNDLE_BINDING_MISMATCH, 'bundle hash binding does not match');
        }
        independentlyMatched = true;
      }
      if (Object.hasOwn(root, 'sourceBundle')) {
        const verifiedSource = verifySourceBundle(
          root.sourceBundle,
          receipt.binding.internalReceiptHash,
        );
        if (verifiedSource.bundleHash !== receipt.binding.bundleHash) {
          fail(ERROR_CODES.BUNDLE_BINDING_MISMATCH, 'verified source bundle does not match');
        }
        verifyDisclosureBinding(receipt.disclosure, verifiedSource.matchedReceipt);
        disclosureBinding = 'matched_against_bundle';
        independentlyMatched = true;
      }
      if (!independentlyMatched) {
        fail(ERROR_CODES.BUNDLE_BINDING_REQUIRED, 'an independent bundle binding is required');
      }
    } else if (Object.hasOwn(root, 'expectedBundleHash') || Object.hasOwn(root, 'sourceBundle')) {
      fail(ERROR_CODES.BUNDLE_BINDING_MISMATCH, 'public receipt does not declare a bundle binding');
    }

    if (!receipt.integrity.signed) {
      fail(ERROR_CODES.UNSIGNED, 'unsigned public receipts cannot be verified for exchange');
    }

    const keyResolution = resolveTrustedKeyState({
      keyReference: receipt.integrity.signature.keyId,
      records: root.trustedKeyRecords,
      evaluationTime: root.evaluationTime,
    });
    if (keyResolution.keyState !== 'active') {
      fail(ERROR_CODES.KEY_NOT_ACTIVE, 'public receipt signing key is not active', {
        keyState: keyResolution.keyState,
        reasonCategory: keyResolution.reasonCategory,
      });
    }

    const signatureBytes = Buffer.from(receipt.integrity.signature.value, 'base64url');
    if (signatureBytes.length !== 64
      || signatureBytes.toString('base64url') !== receipt.integrity.signature.value) {
      fail(ERROR_CODES.SIGNATURE_INVALID, 'public receipt signature encoding is invalid');
    }
    const cryptographic = verifyCryptographicEvidence({
      algorithm: PUBLIC_RECEIPT_SIGNATURE_PROFILE,
      messageBytes: encodeJsonStableV1(signatureProjection(receipt)),
      publicKeySpkiDer: keyResolution.publicKeySpkiDer,
      signatureBytes,
    });
    if (cryptographic.cryptographicState !== 'valid') {
      fail(ERROR_CODES.SIGNATURE_INVALID, 'public receipt signature is invalid');
    }

    return deepFreeze({
      ok: true,
      status: 'verified',
      receipt: snapshotCanonicalJson(
        receipt,
        ERROR_CODES.INVALID_RECEIPT,
        'verified public receipt could not be copied',
      ),
      verification: {
        checksum: 'valid',
        binding: 'matched_independently',
        disclosure: disclosureBinding,
        keyState: 'active',
        signature: 'valid',
      },
    });
  } catch (error) {
    const publicError = error instanceof PublicTrustReceiptError
      ? error
      : new PublicTrustReceiptError(ERROR_CODES.INVALID_RECEIPT, 'public receipt verification failed');
    return deepFreeze({
      ok: false,
      status: 'rejected',
      error: {
        code: publicError.code,
        ...(publicError.details === undefined ? {} : { details: publicError.details }),
      },
    });
  }
}

module.exports = {
  importPublicTrustReceipt,
  parseCanonicalPublicReceiptBytes,
};
