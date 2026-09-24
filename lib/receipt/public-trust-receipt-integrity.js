'use strict';

// #2161: what the checksum and the signature cover, the receipt's shape,
// and its binding to the source bundle and internal receipt.

const crypto = require('node:crypto');
const { hasSecretLookingValue } = require('../tool-call-gate');
const { hashCanonicalReceiptPayload } = require('./canonical-receipt');
const { verifyExportedBundle } = require('./receipt-export');
const { validateV4RecordShape } = require('./v4-receipt-family');
const { CANONICAL_VERDICTS } = require('../verdict/action-verdict');
const { encodeJsonStableV1 } = require('./cryptographic-profile-contract');
const { BINDING_KEYS, DISCLOSURE_KEYS, ERROR_CODES, HASH_PATTERN, INTEGRITY_KEYS, PUBLIC_RECEIPT_CHECKSUM_ALGORITHM, PUBLIC_RECEIPT_SCHEMA_VERSION, PUBLIC_RECEIPT_SIGNATURE_DOMAIN, PUBLIC_RECEIPT_SIGNATURE_PROFILE, ROOT_KEYS, SIGNATURE_KEYS, SIGNATURE_PATTERN, fail } = require('./public-trust-receipt-contract');
const { boundedKeyReference, boundedText, canonicalInstant, hasExactDataKeys, snapshotCanonicalJson, snapshotDataObject } = require('./public-trust-receipt-values');

function checksumProjection(receipt) {
  const integrity = {
    checksumAlgorithm: receipt.integrity.checksumAlgorithm,
    signed: receipt.integrity.signed,
    signature: receipt.integrity.signature,
  };
  return {
    schemaVersion: receipt.schemaVersion,
    publicReceiptId: receipt.publicReceiptId,
    issuedAt: receipt.issuedAt,
    disclosure: receipt.disclosure,
    binding: receipt.binding,
    integrity,
  };
}

function signatureProjection(receipt) {
  return {
    domainLabel: PUBLIC_RECEIPT_SIGNATURE_DOMAIN,
    schemaVersion: receipt.schemaVersion,
    publicReceiptId: receipt.publicReceiptId,
    issuedAt: receipt.issuedAt,
    disclosure: receipt.disclosure,
    binding: receipt.binding,
    integrity: {
      checksumAlgorithm: receipt.integrity.checksumAlgorithm,
      signed: true,
      signature: {
        profileId: receipt.integrity.signature.profileId,
        keyId: receipt.integrity.signature.keyId,
      },
    },
  };
}

function computePublicReceiptChecksum(receipt) {
  return crypto.createHash('sha256')
    .update(encodeJsonStableV1(checksumProjection(receipt)))
    .digest('hex');
}

function validatePublicReceiptShape(receipt) {
  if (!hasExactDataKeys(receipt, ROOT_KEYS)) return ERROR_CODES.INVALID_RECEIPT;
  if (receipt.schemaVersion !== PUBLIC_RECEIPT_SCHEMA_VERSION
    || !HASH_PATTERN.test(receipt.publicReceiptId)
    || !canonicalInstant(receipt.issuedAt)) {
    return ERROR_CODES.INVALID_RECEIPT;
  }
  if (!hasExactDataKeys(receipt.disclosure, DISCLOSURE_KEYS)) return ERROR_CODES.INVALID_RECEIPT;
  const disclosure = receipt.disclosure;
  if (!boundedText(disclosure.receiptKind)
    || !boundedText(disclosure.decision)
    || !CANONICAL_VERDICTS.includes(disclosure.verdict)
    || !boundedText(disclosure.status)
    || typeof disclosure.riskScore !== 'number'
    || !Number.isFinite(disclosure.riskScore)
    || !boundedText(disclosure.trustPolicyVersion)
    || !canonicalInstant(disclosure.createdAt)) {
    return ERROR_CODES.INVALID_RECEIPT;
  }
  if (hasSecretLookingValue(disclosure)) return ERROR_CODES.SECRET_DETECTED;

  const binding = snapshotDataObject(receipt.binding, BINDING_KEYS, new Set(['internalReceiptHash']));
  if (!binding || Reflect.ownKeys(binding).length < 1 || Reflect.ownKeys(binding).length > 2
    || !HASH_PATTERN.test(binding.internalReceiptHash)
    || (Object.hasOwn(binding, 'bundleHash') && !HASH_PATTERN.test(binding.bundleHash))) {
    return ERROR_CODES.INVALID_RECEIPT;
  }

  if (!hasExactDataKeys(receipt.integrity, INTEGRITY_KEYS)) return ERROR_CODES.INVALID_RECEIPT;
  const integrity = receipt.integrity;
  if (integrity.checksumAlgorithm !== PUBLIC_RECEIPT_CHECKSUM_ALGORITHM
    || !HASH_PATTERN.test(integrity.checksum)
    || typeof integrity.signed !== 'boolean') {
    return ERROR_CODES.INVALID_RECEIPT;
  }
  if (!integrity.signed) {
    return integrity.signature === null ? null : ERROR_CODES.INVALID_RECEIPT;
  }
  if (!hasExactDataKeys(integrity.signature, SIGNATURE_KEYS)
    || integrity.signature.profileId !== PUBLIC_RECEIPT_SIGNATURE_PROFILE
    || !boundedKeyReference(integrity.signature.keyId)
    || !SIGNATURE_PATTERN.test(integrity.signature.value)) {
    return ERROR_CODES.INVALID_RECEIPT;
  }
  if (hasSecretLookingValue(integrity.signature.keyId)) return ERROR_CODES.SECRET_DETECTED;
  return null;
}

function verifySourceBundle(sourceBundle, internalReceiptHash) {
  const snapshot = snapshotCanonicalJson(
    sourceBundle,
    ERROR_CODES.INVALID_SOURCE_BUNDLE,
    'source bundle is not bounded canonical JSON',
  );
  let verification;
  try {
    verification = verifyExportedBundle(snapshot);
  } catch (_) {
    fail(ERROR_CODES.INVALID_SOURCE_BUNDLE, 'source bundle verification failed');
  }
  if (!verification.valid || !HASH_PATTERN.test(snapshot.bundleHash)) {
    fail(ERROR_CODES.INVALID_SOURCE_BUNDLE, 'source bundle verification failed');
  }
  const matchedReceipt = snapshot.receipts.find((receipt) => receipt.receiptHash === internalReceiptHash);
  if (!matchedReceipt) {
    fail(
      ERROR_CODES.SOURCE_RECEIPT_NOT_IN_BUNDLE,
      'source bundle does not contain the selected internal receipt',
    );
  }
  return { bundleHash: snapshot.bundleHash, matchedReceipt };
}

function verifyDisclosureBinding(disclosure, matchedReceipt) {
  for (const field of DISCLOSURE_KEYS) {
    if (disclosure[field] !== matchedReceipt[field]) {
      fail(
        ERROR_CODES.BINDING_MISMATCH,
        `disclosure field ${field} does not match the bound internal receipt`,
        { field },
      );
    }
  }
}

function validateInternalReceipt(internalReceipt) {
  const snapshot = snapshotCanonicalJson(
    internalReceipt,
    ERROR_CODES.INVALID_INTERNAL_RECEIPT,
    'internal receipt is not bounded canonical JSON',
  );
  const shape = validateV4RecordShape(snapshot);
  if (!shape.valid || !HASH_PATTERN.test(snapshot.receiptHash)) {
    fail(ERROR_CODES.INVALID_INTERNAL_RECEIPT, 'internal receipt shape is invalid');
  }
  const { receiptHash, ...hashInput } = snapshot;
  if (hashCanonicalReceiptPayload(hashInput) !== receiptHash) {
    fail(ERROR_CODES.INVALID_INTERNAL_RECEIPT, 'internal receipt self-hash is invalid');
  }
  return snapshot;
}

module.exports = {
  checksumProjection,
  computePublicReceiptChecksum,
  signatureProjection,
  validateInternalReceipt,
  validatePublicReceiptShape,
  verifyDisclosureBinding,
  verifySourceBundle,
};
