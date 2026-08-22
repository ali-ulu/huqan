'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { hasSecretLookingValue } = require('../tool-call-gate');
const {
  hashCanonicalReceiptPayload,
  sha256Hex,
} = require('../receipt/canonical-receipt');
const { verifyExportedBundle } = require('../receipt/receipt-export');
const { validateV4RecordShape } = require('../receipt/v4-receipt-family');
const { CANONICAL_VERDICTS } = require('../verdict/action-verdict');
const { encodeJsonStableV1 } = require('./cryptographic-profile-contract');
const { verifyCryptographicEvidence } = require('./cryptographic-verification-adapter');
const { resolveTrustedKeyState } = require('./trusted-key-resolver');

const PUBLIC_RECEIPT_SCHEMA_VERSION = 'v5-public-trust-receipt-v1';
const PUBLIC_RECEIPT_SIGNATURE_DOMAIN = 'HUQAN/V5/PUBLIC-TRUST-RECEIPT/v1';
const PUBLIC_RECEIPT_SIGNATURE_PROFILE = 'ed25519-v1';
const PUBLIC_RECEIPT_CHECKSUM_ALGORITHM = 'sha256-canonical-json-v1';
const MAX_PUBLIC_RECEIPT_BYTES = 1024 * 1024;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY_REFERENCE_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const KEY_REFERENCE_PATH_PATTERN = /[\\/?#@]/;
const KEY_REFERENCE_WHITESPACE_PATTERN = /\s/;
const KEY_REFERENCE_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

const ROOT_KEYS = Object.freeze([
  'schemaVersion',
  'publicReceiptId',
  'issuedAt',
  'disclosure',
  'binding',
  'integrity',
]);
const DISCLOSURE_KEYS = Object.freeze([
  'receiptKind',
  'decision',
  'verdict',
  'status',
  'riskScore',
  'trustPolicyVersion',
  'createdAt',
]);
const BINDING_KEYS = new Set(['internalReceiptHash', 'bundleHash']);
const INTEGRITY_KEYS = Object.freeze([
  'checksumAlgorithm',
  'checksum',
  'signed',
  'signature',
]);
const SIGNATURE_KEYS = Object.freeze(['profileId', 'keyId', 'value']);
const EXPORT_KEYS = new Set(['internalReceipt', 'issuedAt', 'signer', 'sourceBundle']);
const SIGNER_KEYS = new Set(['keyId', 'privateKey']);
const IMPORT_KEYS = new Set([
  'expectedInternalReceiptHash',
  'expectedBundleHash',
  'sourceBundle',
  'trustedKeyRecords',
  'evaluationTime',
]);

const ERROR_CODES = Object.freeze({
  INVALID_EXPORT_INPUT: 'PUBLIC_RECEIPT_INVALID_EXPORT_INPUT',
  INVALID_INTERNAL_RECEIPT: 'PUBLIC_RECEIPT_INVALID_INTERNAL_RECEIPT',
  INVALID_SOURCE_BUNDLE: 'PUBLIC_RECEIPT_INVALID_SOURCE_BUNDLE',
  SOURCE_RECEIPT_NOT_IN_BUNDLE: 'PUBLIC_RECEIPT_SOURCE_RECEIPT_NOT_IN_BUNDLE',
  SECRET_DETECTED: 'PUBLIC_RECEIPT_SECRET_DETECTED',
  INVALID_SIGNER: 'PUBLIC_RECEIPT_INVALID_SIGNER',
  INVALID_RECEIPT: 'PUBLIC_RECEIPT_INVALID',
  NON_CANONICAL: 'PUBLIC_RECEIPT_NON_CANONICAL',
  SIZE_LIMIT: 'PUBLIC_RECEIPT_SIZE_LIMIT_EXCEEDED',
  CHECKSUM_INVALID: 'PUBLIC_RECEIPT_CHECKSUM_INVALID',
  BINDING_MISMATCH: 'PUBLIC_RECEIPT_BINDING_MISMATCH',
  BUNDLE_BINDING_REQUIRED: 'PUBLIC_RECEIPT_BUNDLE_BINDING_REQUIRED',
  BUNDLE_BINDING_MISMATCH: 'PUBLIC_RECEIPT_BUNDLE_BINDING_MISMATCH',
  UNSIGNED: 'PUBLIC_RECEIPT_UNSIGNED',
  KEY_NOT_ACTIVE: 'PUBLIC_RECEIPT_KEY_NOT_ACTIVE',
  SIGNATURE_INVALID: 'PUBLIC_RECEIPT_SIGNATURE_INVALID',
  UNSAFE_PATH: 'PUBLIC_RECEIPT_UNSAFE_PATH',
  TARGET_EXISTS: 'PUBLIC_RECEIPT_TARGET_EXISTS',
  FILE_READ_FAILED: 'PUBLIC_RECEIPT_FILE_READ_FAILED',
  FILE_WRITE_FAILED: 'PUBLIC_RECEIPT_FILE_WRITE_FAILED',
});

class PublicTrustReceiptError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PublicTrustReceiptError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PublicTrustReceiptError(code, message, details);
}

const { isPlainObject } = require('../is-plain-object');

function snapshotDataObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainObject(value)) return null;
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (_) {
    return null;
  }
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) return null;
  for (const required of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, required)) return null;
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function hasExactDataKeys(value, expectedKeys) {
  const snapshot = snapshotDataObject(value, new Set(expectedKeys), expectedKeys);
  return snapshot !== null && Reflect.ownKeys(snapshot).length === expectedKeys.length;
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function boundedText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && value.trim() === value;
}

function boundedKeyReference(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || KEY_REFERENCE_WHITESPACE_PATTERN.test(value)
    || KEY_REFERENCE_CONTROL_PATTERN.test(value)
    || KEY_REFERENCE_PATH_PATTERN.test(value)) {
    return false;
  }
  if (value.includes('://')) return false;
  const schemeMatch = value.match(KEY_REFERENCE_SCHEME_PATTERN);
  return !schemeMatch || schemeMatch[1].toLowerCase() === 'test-key';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotCanonicalJson(value, code, message) {
  try {
    const bytes = encodeJsonStableV1(value);
    return JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    fail(code, message);
  }
}

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
  if (!snapshot.receipts.some((receipt) => receipt.receiptHash === internalReceiptHash)) {
    fail(
      ERROR_CODES.SOURCE_RECEIPT_NOT_IN_BUNDLE,
      'source bundle does not contain the selected internal receipt',
    );
  }
  return snapshot.bundleHash;
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
    binding.bundleHash = verifySourceBundle(root.sourceBundle, internal.receiptHash);
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
        const verifiedBundleHash = verifySourceBundle(
          root.sourceBundle,
          receipt.binding.internalReceiptHash,
        );
        if (verifiedBundleHash !== receipt.binding.bundleHash) {
          fail(ERROR_CODES.BUNDLE_BINDING_MISMATCH, 'verified source bundle does not match');
        }
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

function sameResolvedPath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveSafeParent(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    fail(ERROR_CODES.UNSAFE_PATH, 'public receipt path is invalid');
  }
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  let stat;
  let realParent;
  try {
    stat = fs.lstatSync(parent);
    realParent = fs.realpathSync.native(parent);
  } catch (_) {
    fail(ERROR_CODES.UNSAFE_PATH, 'public receipt parent directory is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameResolvedPath(parent, realParent)) {
    fail(ERROR_CODES.UNSAFE_PATH, 'public receipt parent directory is not a real directory');
  }
  return resolved;
}

function writePublicTrustReceiptFile(filePath, receipt) {
  const bytes = toCanonicalPublicReceiptBytes(receipt);
  const resolved = resolveSafeParent(filePath);
  try {
    fs.lstatSync(resolved);
    fail(ERROR_CODES.TARGET_EXISTS, 'public receipt target already exists');
  } catch (error) {
    if (error instanceof PublicTrustReceiptError) throw error;
    if (error?.code !== 'ENOENT') fail(ERROR_CODES.UNSAFE_PATH, 'public receipt target is unsafe');
  }

  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(resolved, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    return Object.freeze({ path: resolved, bytesWritten: bytes.length });
  } catch (error) {
    if (error instanceof PublicTrustReceiptError) throw error;
    if (error?.code === 'EEXIST') {
      fail(ERROR_CODES.TARGET_EXISTS, 'public receipt target already exists');
    }
    if (created) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* rollback still remains best-effort */ }
        descriptor = undefined;
      }
      try { fs.unlinkSync(resolved); } catch (_) { /* best-effort rollback of our exclusive file */ }
    }
    fail(ERROR_CODES.FILE_WRITE_FAILED, 'public receipt file write failed');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) { /* close cannot change the write verdict */ }
    }
  }
}

function readPublicTrustReceiptFile(filePath, options) {
  let descriptor;
  try {
    const resolved = resolveSafeParent(filePath);
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const stat = fs.lstatSync(resolved, { bigint: true });
    const real = fs.realpathSync.native(resolved);
    if (!opened.isFile()
      || !stat.isFile()
      || stat.isSymbolicLink()
      || opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || !sameResolvedPath(resolved, real)) {
      fail(ERROR_CODES.UNSAFE_PATH, 'public receipt target is not a real file');
    }
    if (opened.size < 1n || opened.size > BigInt(MAX_PUBLIC_RECEIPT_BYTES)) {
      fail(ERROR_CODES.SIZE_LIMIT, 'public receipt exceeds the byte limit');
    }
    return importPublicTrustReceipt(fs.readFileSync(descriptor), options);
  } catch (error) {
    if (error instanceof PublicTrustReceiptError) {
      return deepFreeze({ ok: false, status: 'rejected', error: { code: error.code } });
    }
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      return deepFreeze({
        ok: false,
        status: 'rejected',
        error: { code: ERROR_CODES.UNSAFE_PATH },
      });
    }
    return deepFreeze({
      ok: false,
      status: 'rejected',
      error: { code: ERROR_CODES.FILE_READ_FAILED },
    });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) { /* read result is already bounded */ }
    }
  }
}

module.exports = {
  ERROR_CODES,
  MAX_PUBLIC_RECEIPT_BYTES,
  PUBLIC_RECEIPT_SCHEMA_VERSION,
  PUBLIC_RECEIPT_SIGNATURE_DOMAIN,
  PublicTrustReceiptError,
  computePublicReceiptChecksum,
  exportPublicTrustReceipt,
  importPublicTrustReceipt,
  readPublicTrustReceiptFile,
  toCanonicalPublicReceiptBytes,
  writePublicTrustReceiptFile,
};
