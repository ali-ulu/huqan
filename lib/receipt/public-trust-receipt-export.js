'use strict';

// #2161: issuing a public receipt from an internal one, and its canonical bytes.

const crypto = require('node:crypto');
const { hasSecretLookingValue } = require('../tool-call-gate');
const { sha256Hex } = require('./canonical-receipt');
const { encodeJsonStableV1 } = require('./cryptographic-profile-contract');
const { DISCLOSURE_KEYS, ERROR_CODES, EXPORT_KEYS, PUBLIC_RECEIPT_CHECKSUM_ALGORITHM, PUBLIC_RECEIPT_SCHEMA_VERSION, PUBLIC_RECEIPT_SIGNATURE_PROFILE, SIGNER_KEYS, fail } = require('./public-trust-receipt-contract');
const { computePublicReceiptChecksum, signatureProjection, validateInternalReceipt, validatePublicReceiptShape, verifySourceBundle } = require('./public-trust-receipt-integrity');
const { boundedKeyReference, canonicalInstant, deepFreeze, snapshotCanonicalJson, snapshotDataObject } = require('./public-trust-receipt-values');

function exportPublicTrustReceipt(input) {
  const root = snapshotDataObject(input, EXPORT_KEYS, new Set(['internalReceipt', 'issuedAt', 'signer']));
  if (!root || !canonicalInstant(root.issuedAt)) {
    fail(ERROR_CODES.INVALID_EXPORT_INPUT, 'export input is malformed');
  }
  const signer = snapshotDataObject(root.signer, SIGNER_KEYS, SIGNER_KEYS);
  if (!signer || !boundedKeyReference(signer.keyId)
    || !(signer.privateKey instanceof crypto.KeyObject)
    || signer.privateKey.type !== 'private'
    || signer.privateKey.asymmetricKeyType !== 'ed25519') {
    fail(ERROR_CODES.INVALID_SIGNER, 'signer must contain an Ed25519 private KeyObject');
  }
  if (hasSecretLookingValue(signer.keyId)) {
    fail(ERROR_CODES.SECRET_DETECTED, 'public signing key reference looks secret');
  }

  const internal = validateInternalReceipt(root.internalReceipt);
  const disclosure = Object.fromEntries(DISCLOSURE_KEYS.map((field) => [field, internal[field]]));
  if (hasSecretLookingValue(disclosure)) {
    fail(ERROR_CODES.SECRET_DETECTED, 'an allowlisted disclosure value looks secret');
  }

  const binding = { internalReceiptHash: internal.receiptHash };
  if (Object.hasOwn(root, 'sourceBundle')) {
    binding.bundleHash = verifySourceBundle(root.sourceBundle, internal.receiptHash).bundleHash;
  }

  const receipt = {
    schemaVersion: PUBLIC_RECEIPT_SCHEMA_VERSION,
    publicReceiptId: sha256Hex(internal.receiptId),
    issuedAt: root.issuedAt,
    disclosure,
    binding,
    integrity: {
      checksumAlgorithm: PUBLIC_RECEIPT_CHECKSUM_ALGORITHM,
      checksum: '0'.repeat(64),
      signed: true,
      signature: {
        profileId: PUBLIC_RECEIPT_SIGNATURE_PROFILE,
        keyId: signer.keyId,
        value: '',
      },
    },
  };

  const signatureBytes = crypto.sign(
    null,
    encodeJsonStableV1(signatureProjection(receipt)),
    signer.privateKey,
  );
  receipt.integrity.signature.value = signatureBytes.toString('base64url');
  receipt.integrity.checksum = computePublicReceiptChecksum(receipt);

  const shapeError = validatePublicReceiptShape(receipt);
  if (shapeError) fail(shapeError, 'constructed public receipt is invalid');
  return deepFreeze(receipt);
}

function toCanonicalPublicReceiptBytes(receipt) {
  const snapshot = snapshotCanonicalJson(
    receipt,
    ERROR_CODES.INVALID_RECEIPT,
    'public receipt is not bounded canonical JSON',
  );
  const shapeError = validatePublicReceiptShape(snapshot);
  if (shapeError) fail(shapeError, 'public receipt shape is invalid');
  if (computePublicReceiptChecksum(snapshot) !== snapshot.integrity.checksum) {
    fail(ERROR_CODES.CHECKSUM_INVALID, 'public receipt checksum is invalid');
  }
  return encodeJsonStableV1(snapshot);
}

module.exports = {
  exportPublicTrustReceipt,
  toCanonicalPublicReceiptBytes,
};
