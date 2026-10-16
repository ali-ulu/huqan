'use strict';

// #2218: the package gate's version, signature algorithm, key statuses and
// error codes, and the normalization of the caller identity and signature.

const EXTERNAL_CLIENT_PACKAGE_GATE_VERSION = 'tb-a6-v2';
const SUPPORTED_SIGNATURE_ALGORITHM = 'ed25519';
const TRUSTED_KEY_STATUSES = Object.freeze(['active', 'revoked', 'expired']);

const EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS = Object.freeze({
  MISSING_IDENTITY: 'EXTERNAL_CLIENT_IDENTITY_REQUIRED',
  MISSING_WORKSPACE: 'EXTERNAL_CLIENT_WORKSPACE_REQUIRED',
  AUTHORITATIVE_WORKSPACE_REQUIRED: 'EXTERNAL_CLIENT_AUTHORITATIVE_WORKSPACE_REQUIRED',
  WORKSPACE_MISMATCH: 'EXTERNAL_CLIENT_WORKSPACE_MISMATCH',
  INVALID_PACKAGE: 'EXTERNAL_CLIENT_PACKAGE_INVALID',
  EXPECTED_PACKAGE_REQUIRED: 'EXTERNAL_CLIENT_EXPECTED_PACKAGE_REQUIRED',
  PACKAGE_ID_MISMATCH: 'EXTERNAL_CLIENT_PACKAGE_ID_MISMATCH',
  PACKAGE_WORKSPACE_MISMATCH: 'EXTERNAL_CLIENT_PACKAGE_WORKSPACE_MISMATCH',
  PACKAGE_IDENTITY_MISMATCH: 'EXTERNAL_CLIENT_PACKAGE_IDENTITY_MISMATCH',
  SIGNATURE_REQUIRED: 'EXTERNAL_CLIENT_SIGNATURE_REQUIRED',
  SIGNATURE_ALGORITHM_UNSUPPORTED: 'EXTERNAL_CLIENT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  TRUSTED_KEY_REQUIRED: 'EXTERNAL_CLIENT_TRUSTED_KEY_REQUIRED',
  TRUSTED_KEY_STATUS_INVALID: 'EXTERNAL_CLIENT_TRUSTED_KEY_STATUS_INVALID',
  TRUSTED_KEY_REVOKED: 'EXTERNAL_CLIENT_TRUSTED_KEY_REVOKED',
  TRUSTED_KEY_EXPIRED: 'EXTERNAL_CLIENT_TRUSTED_KEY_EXPIRED',
  TRUSTED_KEY_SCOPE_MISMATCH: 'EXTERNAL_CLIENT_TRUSTED_KEY_SCOPE_MISMATCH',
  SIGNATURE_INVALID: 'EXTERNAL_CLIENT_SIGNATURE_INVALID',
});

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = { ...details };
  throw error;
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.MISSING_IDENTITY,
      'external client identity is required',
    );
  }

  const subject = cleanString(identity.subject);
  const kind = cleanString(identity.kind);
  if (!subject || !kind) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.MISSING_IDENTITY,
      'external client identity.subject and identity.kind are required',
    );
  }

  return Object.freeze({ subject, kind });
}

function normalizeSignature(signature) {
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_REQUIRED,
      'external client package signature is required',
    );
  }

  const algorithm = cleanString(signature.algorithm).toLowerCase();
  const keyId = cleanString(signature.keyId);
  const value = cleanString(signature.value);

  if (!algorithm || !keyId || !value) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_REQUIRED,
      'signature.algorithm, signature.keyId and signature.value are required',
    );
  }

  if (algorithm !== SUPPORTED_SIGNATURE_ALGORITHM) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_ALGORITHM_UNSUPPORTED,
      `signature algorithm must be ${SUPPORTED_SIGNATURE_ALGORITHM}`,
      { algorithm },
    );
  }

  return Object.freeze({ algorithm, keyId, value });
}

module.exports = {
  EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS,
  EXTERNAL_CLIENT_PACKAGE_GATE_VERSION,
  SUPPORTED_SIGNATURE_ALGORITHM,
  TRUSTED_KEY_STATUSES,
  cleanString,
  fail,
  normalizeIdentity,
  normalizeSignature,
};
