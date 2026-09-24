'use strict';

// #2161: the public receipt's versioned contract -- schema, signature domain
// and profile, checksum algorithm, patterns, exact key sets, error codes.

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
const KEY_REFERENCE_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/; // oxlint-disable-line no-control-regex -- deliberate: the control-character class a key reference may not contain

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

module.exports = {
  BINDING_KEYS,
  DISCLOSURE_KEYS,
  ERROR_CODES,
  EXPORT_KEYS,
  HASH_PATTERN,
  IMPORT_KEYS,
  INTEGRITY_KEYS,
  KEY_REFERENCE_CONTROL_PATTERN,
  KEY_REFERENCE_PATH_PATTERN,
  KEY_REFERENCE_SCHEME_PATTERN,
  KEY_REFERENCE_WHITESPACE_PATTERN,
  MAX_PUBLIC_RECEIPT_BYTES,
  PUBLIC_RECEIPT_CHECKSUM_ALGORITHM,
  PUBLIC_RECEIPT_SCHEMA_VERSION,
  PUBLIC_RECEIPT_SIGNATURE_DOMAIN,
  PUBLIC_RECEIPT_SIGNATURE_PROFILE,
  PublicTrustReceiptError,
  ROOT_KEYS,
  SIGNATURE_KEYS,
  SIGNATURE_PATTERN,
  SIGNER_KEYS,
  TIMESTAMP_PATTERN,
  fail,
};
