'use strict';

const {
  ALLOWED_TRUSTED_KEY_METADATA_KEYS,
  FORBIDDEN_KEY_MATERIAL_KEYS,
  containsForbiddenKeyMaterial,
  hasOnlyKeys,
  isNonEmptyString
} = require('./verification-input-shape');

const { isPlainObject } = require('../is-plain-object');

const KEY_STATE_REASONS = new Map([
  ['unknown', 'unknown_key'],
  ['revoked', 'revoked_key'],
  ['expired', 'expired_key_metadata'],
  ['unavailable', 'key_lookup_unavailable'],
  ['malformed', 'malformed_trusted_key_record']
]);

function forbiddenClaimReason(claims) {
  if (claims === undefined) {
    return null;
  }
  if (!isPlainObject(claims)) {
    return 'malformed_signature_evidence';
  }
  if (Object.hasOwn(claims, 'packageTrust')) {
    return 'forbidden_trust_claim';
  }
  if (Object.hasOwn(claims, 'actionAuthorization')) {
    return 'forbidden_authorization_claim';
  }
  if (Object.hasOwn(claims, 'externalExchange')) {
    return 'forbidden_exchange_claim';
  }
  return Object.keys(claims).length === 0 ? null : 'malformed_signature_evidence';
}

function keyStateReason(input) {
  const metadata = input.trustedKeyMetadata;
  if (
    !hasOnlyKeys(metadata, ALLOWED_TRUSTED_KEY_METADATA_KEYS) ||
    containsForbiddenKeyMaterial(metadata)
  ) {
    return 'malformed_trusted_key_record';
  }
  if (!isNonEmptyString(metadata.status)) {
    return 'malformed_trusted_key_record';
  }
  if (!isNonEmptyString(metadata.keyReference) || metadata.keyReference !== input.keyReference) {
    return 'malformed_trusted_key_record';
  }
  if (
    metadata.expiresAt !== undefined &&
    (!isNonEmptyString(metadata.expiresAt) || Number.isNaN(Date.parse(metadata.expiresAt)))
  ) {
    return 'malformed_trusted_key_record';
  }
  if (KEY_STATE_REASONS.has(metadata.status)) {
    return KEY_STATE_REASONS.get(metadata.status);
  }
  if (metadata.status !== 'active') {
    return 'malformed_trusted_key_record';
  }
  // A declared 'active' status does not override an expiresAt that has
  // already passed relative to evaluationTime -- mirrors the comparison
  // trusted-key-resolver.js already makes (#1274). evaluationTime is
  // guaranteed parseable here: malformedInput rejects it otherwise before
  // keyStateReason is ever called.
  if (
    metadata.expiresAt !== undefined &&
    Date.parse(metadata.expiresAt) <= Date.parse(input.evaluationTime)
  ) {
    return KEY_STATE_REASONS.get('expired');
  }
  return null;
}

// This is a bounded *structural* verifier: SUPPORTED_ALGORITHM is a synthetic
// test algorithm id, and the module has no cryptographic, network, or clock
// dependency at all (enforced by a dedicated test below). A non-empty
// signature is therefore never more than structurally well-formed here, and
// this function makes no claim to have checked it cryptographically -- it
// always returns a reason, by design, so evaluateBoundedVerification falls
// through to not_verified for every input, however well-formed (#1299).
function signatureReason(signature) {
  if (!isNonEmptyString(signature)) {
    return 'missing_signature_evidence';
  }
  return 'malformed_signature_evidence';
}

module.exports = {
  FORBIDDEN_KEY_MATERIAL_KEYS,
  KEY_STATE_REASONS,
  forbiddenClaimReason,
  keyStateReason,
  signatureReason
};
