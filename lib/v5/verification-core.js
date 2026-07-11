'use strict';

const SUPPORTED_SCHEMA_VERSION = 'v5.shared_trust_package.writer_input.v1';
const SUPPORTED_ALGORITHM = 'test-structural-v1';
const SYNTHETIC_SIGNATURE_PATTERN = /^synthetic-signature-placeholder:v1:case-\d{2}$/;

const ALLOWED_INPUT_KEYS = new Set([
  'schemaVersion',
  'algorithm',
  'payload',
  'signature',
  'keyReference',
  'trustedKeyMetadata',
  'claims',
  'evaluationTime'
]);
const ALLOWED_PAYLOAD_KEYS = new Set([
  'canonicalization',
  'payloadId',
  'signedPayloadId',
  'contentRef',
  'payloadDigest',
  'expectedPayloadDigest'
]);
const ALLOWED_TRUSTED_KEY_METADATA_KEYS = new Set([
  'status',
  'keyReference',
  'expiresAt'
]);
const FORBIDDEN_KEY_MATERIAL_KEYS = new Set([
  'privatekey',
  'private_key',
  'secret',
  'credential',
  'token',
  'password',
  'networkendpoint',
  'network_endpoint',
  'url',
  'uri',
  'endpoint',
  'certificate',
  'pem',
  'jwk',
  'keymaterial',
  'key_material'
]);
const KEY_STATE_REASONS = new Map([
  ['unknown', 'unknown_key'],
  ['revoked', 'revoked_key'],
  ['expired', 'expired_key_metadata'],
  ['unavailable', 'key_lookup_unavailable'],
  ['malformed', 'malformed_trusted_key_record']
]);
const CRYPTOGRAPHIC_EVIDENCE_REASONS = new Map([
  ['invalid', new Set(['signature_invalid'])],
  ['malformed', new Set([
    'input_malformed',
    'message_malformed',
    'public_key_malformed',
    'signature_malformed'
  ])],
  ['unsupported', new Set(['algorithm_unsupported'])]
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function result(verificationStatus, reasonCategory) {
  return { verificationStatus, reasonCategory };
}

function notVerified(reasonCategory) {
  return result('not_verified', reasonCategory);
}

function malformedCryptographicEvidence() {
  return {
    cryptographicState: 'malformed',
    reasonCategory: 'input_malformed'
  };
}

function hasOnlyOwnDataKeys(value, allowedKeys) {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.getOwnPropertyNames(value);
  if (!keys.every((key) => allowedKeys.has(key))) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor.enumerable && !descriptor.get && !descriptor.set;
  });
}

function normalizeCryptographicVerificationEvidence(evidence) {
  try {
    if (!isPlainObject(evidence)) {
      return malformedCryptographicEvidence();
    }

    const stateDescriptor = Object.getOwnPropertyDescriptor(
      evidence,
      'cryptographicState'
    );
    if (!stateDescriptor || stateDescriptor.get || stateDescriptor.set) {
      return malformedCryptographicEvidence();
    }
    const state = stateDescriptor.value;
    if (state === 'valid') {
      if (!hasOnlyOwnDataKeys(evidence, new Set(['cryptographicState']))) {
        return malformedCryptographicEvidence();
      }
      return { cryptographicState: 'valid' };
    }

    const allowedReasons = CRYPTOGRAPHIC_EVIDENCE_REASONS.get(state);
    if (!allowedReasons || !hasOnlyOwnDataKeys(
      evidence,
      new Set(['cryptographicState', 'reasonCategory'])
    )) {
      return malformedCryptographicEvidence();
    }
    if (!allowedReasons.has(evidence.reasonCategory)) {
      return malformedCryptographicEvidence();
    }
    return {
      cryptographicState: state,
      reasonCategory: evidence.reasonCategory
    };
  } catch {
    return malformedCryptographicEvidence();
  }
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function containsForbiddenKeyMaterial(value) {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenKeyMaterial);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(([key, nestedValue]) => (
    FORBIDDEN_KEY_MATERIAL_KEYS.has(key.toLowerCase()) ||
    containsForbiddenKeyMaterial(nestedValue)
  ));
}

function malformedInput(input) {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ALLOWED_INPUT_KEYS)) {
    return true;
  }
  if (input.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return true;
  }
  if (!isPlainObject(input.payload) || !hasOnlyKeys(input.payload, ALLOWED_PAYLOAD_KEYS)) {
    return true;
  }
  if (
    input.payload.canonicalization !== 'json-stable-v1' ||
    !isNonEmptyString(input.payload.payloadId) ||
    !isNonEmptyString(input.payload.contentRef) ||
    !isNonEmptyString(input.payload.payloadDigest)
  ) {
    return true;
  }
  if (!isNonEmptyString(input.keyReference)) {
    return true;
  }
  if (!isPlainObject(input.trustedKeyMetadata)) {
    return true;
  }
  if (!isNonEmptyString(input.evaluationTime) || Number.isNaN(Date.parse(input.evaluationTime))) {
    return true;
  }
  return false;
}

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
  return null;
}

function signatureReason(signature) {
  if (!isNonEmptyString(signature)) {
    return 'missing_signature_evidence';
  }
  if (!SYNTHETIC_SIGNATURE_PATTERN.test(signature)) {
    return 'malformed_signature_evidence';
  }
  return null;
}

function evaluateBoundedVerification(input) {
  if (!isPlainObject(input) || !isNonEmptyString(input.signature)) {
    return notVerified('missing_signature_evidence');
  }
  if (malformedInput(input)) {
    return notVerified('malformed_signature_evidence');
  }

  const claimReason = forbiddenClaimReason(input.claims);
  if (claimReason) {
    return notVerified(claimReason);
  }
  if (input.algorithm !== SUPPORTED_ALGORITHM) {
    return notVerified('unsupported_algorithm');
  }
  if (
    input.payload.signedPayloadId !== undefined &&
    input.payload.signedPayloadId !== input.payload.payloadId
  ) {
    return notVerified('payload_identity_mismatch');
  }
  if (
    input.payload.expectedPayloadDigest !== undefined &&
    input.payload.expectedPayloadDigest !== input.payload.payloadDigest
  ) {
    return notVerified('payload_digest_mismatch');
  }

  const stateReason = keyStateReason(input);
  if (stateReason) {
    return notVerified(stateReason);
  }
  const evidenceReason = signatureReason(input.signature);
  if (evidenceReason) {
    return notVerified(evidenceReason);
  }
  return result('verified', 'signature_valid');
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_ALGORITHM,
  normalizeCryptographicVerificationEvidence,
  evaluateBoundedVerification
};
