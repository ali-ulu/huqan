'use strict';

const SUPPORTED_SCHEMA_VERSION = 'v5.shared_trust_package.writer_input.v1';
const SUPPORTED_ALGORITHM = 'test-structural-v1';
const STRUCTURAL_SIGNATURE_PLACEHOLDER = 'STRUCTURAL_PLACEHOLDER_NOT_CRYPTOGRAPHIC';

const TOP_LEVEL_KEYS = new Set([
  'fixtureType',
  'caseId',
  'description',
  'signingInput',
  'expected',
  'nonClaims',
  'claims'
]);
const SIGNING_INPUT_KEYS = new Set([
  'schemaVersion',
  'packageId',
  'payload',
  'keyId',
  'algorithm',
  'signature',
  'keyMetadata',
  'trustStatus'
]);
const PAYLOAD_KEYS = new Set([
  'canonicalization',
  'contentRef',
  'payloadDigest'
]);
const KEY_METADATA_KEYS = new Set(['ownerType', 'workspaceBinding']);
const CLAIM_REASON_CATEGORIES = new Map([
  ['signed', 'signature_claim_without_data'],
  ['signatureRuntime', 'signing_runtime_claim'],
  ['verificationRuntime', 'verification_claim'],
  ['verificationRuntimeImplemented', 'verification_claim'],
  ['a2aTransport', 'a2a_transport_claim'],
  ['a2aTransportEnabled', 'a2a_transport_claim'],
  ['connectorEnforcement', 'connector_enforcement_claim'],
  ['connectorEnforcementImplemented', 'connector_enforcement_claim'],
  ['marketplaceReady', 'marketplace_claim'],
  ['marketplaceImplemented', 'marketplace_claim'],
  ['agentActionPolicyEngine', 'agentaction_policy_engine_claim'],
  ['agentActionPolicyEngineEnabled', 'agentaction_policy_engine_claim'],
  ['transportEnabled', 'transport_claim']
]);
const STATUS_BY_REASON = new Map([
  ['malformed_signature_metadata', 'malformed'],
  ['malformed_signing_payload_metadata', 'malformed'],
  ['malformed_key_metadata', 'malformed'],
  ['malformed_non_claims', 'malformed'],
  ['malformed_claims', 'malformed'],
  ['invalid_json_value', 'malformed'],
  ['unknown_top_level_field', 'malformed'],
  ['unknown_signing_input_field', 'malformed'],
  ['unknown_payload_field', 'malformed'],
  ['unknown_key_metadata_field', 'malformed'],
  ['missing_signing_input', 'missing_required_field'],
  ['missing_trust_package_identity', 'missing_required_field'],
  ['missing_signing_payload', 'missing_required_field'],
  ['missing_key_identifier', 'missing_required_field'],
  ['missing_non_claims', 'missing_required_field'],
  ['unsupported_signing_algorithm', 'unsupported_algorithm'],
  ['unsupported_claim', 'unsupported_claim'],
  ['signature_claim_without_data', 'unsupported_claim'],
  ['signing_runtime_claim', 'unsupported_claim'],
  ['verification_claim', 'unsupported_claim'],
  ['trust_claim', 'unsupported_claim'],
  ['authorization_claim', 'unsupported_claim'],
  ['transport_claim', 'unsupported_claim'],
  ['a2a_transport_claim', 'unsupported_claim'],
  ['connector_enforcement_claim', 'unsupported_claim'],
  ['marketplace_claim', 'unsupported_claim'],
  ['agentaction_policy_engine_claim', 'unsupported_claim']
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

function failure(reasonCategory) {
  return {
    ok: false,
    status: STATUS_BY_REASON.get(reasonCategory) || 'blocked',
    reason_category: reasonCategory
  };
}

function findJsonSafetyError(value, ancestors = new Set()) {
  if (
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    value === undefined
  ) {
    return 'invalid_json_value';
  }

  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
    return typeof value === 'number' && !Number.isFinite(value)
      ? 'invalid_json_value'
      : null;
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    return 'invalid_json_value';
  }

  if (ancestors.has(value)) {
    return 'invalid_json_value';
  }

  ancestors.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const error = findJsonSafetyError(nested, ancestors);
    if (error) {
      ancestors.delete(value);
      return error;
    }
  }
  ancestors.delete(value);
  return null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstUnknownKey(value, allowedKeys) {
  return Object.keys(value).find((key) => !allowedKeys.has(key));
}

function validateKeyMetadata(value) {
  if (!isPlainObject(value)) {
    return 'malformed_key_metadata';
  }
  if (firstUnknownKey(value, KEY_METADATA_KEYS)) {
    return 'unknown_key_metadata_field';
  }
  if (!Object.values(value).every(isNonEmptyString)) {
    return 'malformed_key_metadata';
  }
  return null;
}

function validateClaims(claims) {
  if (claims === undefined) {
    return null;
  }
  if (!isPlainObject(claims)) {
    return 'malformed_claims';
  }
  for (const [key, value] of Object.entries(claims)) {
    if (!CLAIM_REASON_CATEGORIES.has(key)) {
      return 'unsupported_claim';
    }
    if (typeof value !== 'boolean') {
      return 'malformed_claims';
    }
    if (value) {
      return CLAIM_REASON_CATEGORIES.get(key);
    }
  }
  return null;
}

function getValidReasonCategory(input) {
  if (input.keyMetadata !== undefined) {
    return 'valid_signing_key_metadata';
  }
  if (isNonEmptyString(input.payload.payloadDigest)) {
    return 'valid_signing_payload_metadata';
  }
  return 'valid_signing_shape';
}

function validateStructuralSigningInput(candidate) {
  const jsonSafetyError = findJsonSafetyError(candidate);
  if (jsonSafetyError) {
    return failure(jsonSafetyError);
  }
  if (!isPlainObject(candidate)) {
    return failure('invalid_signing_input');
  }
  if (firstUnknownKey(candidate, TOP_LEVEL_KEYS)) {
    return failure('unknown_top_level_field');
  }
  if (!isPlainObject(candidate.signingInput)) {
    return failure('missing_signing_input');
  }

  const input = candidate.signingInput;
  if (firstUnknownKey(input, SIGNING_INPUT_KEYS)) {
    return failure('unknown_signing_input_field');
  }
  if (input.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return failure('unsupported_schema_version');
  }
  if (!isNonEmptyString(input.packageId)) {
    return failure('missing_trust_package_identity');
  }
  if (!isPlainObject(input.payload)) {
    return failure('missing_signing_payload');
  }
  if (firstUnknownKey(input.payload, PAYLOAD_KEYS)) {
    return failure('unknown_payload_field');
  }
  if (input.payload.canonicalization !== 'json-stable-v1') {
    return failure('unsupported_canonicalization');
  }
  if (!isNonEmptyString(input.payload.contentRef)) {
    return failure('missing_signing_payload');
  }
  if (
    input.payload.payloadDigest !== undefined &&
    !isNonEmptyString(input.payload.payloadDigest)
  ) {
    return failure('malformed_signing_payload_metadata');
  }
  if (!isNonEmptyString(input.keyId)) {
    return failure('missing_key_identifier');
  }
  if (input.keyMetadata !== undefined) {
    const keyMetadataError = validateKeyMetadata(input.keyMetadata);
    if (keyMetadataError) {
      return failure(keyMetadataError);
    }
  }
  if (input.algorithm !== SUPPORTED_ALGORITHM) {
    return failure('unsupported_signing_algorithm');
  }
  if (
    input.signature !== undefined &&
    input.signature !== STRUCTURAL_SIGNATURE_PLACEHOLDER
  ) {
    return failure('malformed_signature_metadata');
  }

  const claimsError = validateClaims(candidate.claims);
  if (claimsError) {
    return failure(claimsError);
  }
  if (input.trustStatus !== undefined) {
    return failure('trust_claim');
  }
  if (!Array.isArray(candidate.nonClaims) || candidate.nonClaims.length === 0) {
    return failure('missing_non_claims');
  }
  if (!candidate.nonClaims.every(isNonEmptyString)) {
    return failure('malformed_non_claims');
  }
  return null;
}

function prepareStructuralSigning(candidate) {
  try {
    const invalid = validateStructuralSigningInput(candidate);
    if (invalid) {
      return invalid;
    }

    const input = candidate.signingInput;
    const result = {
      ok: true,
      status: 'structural_only',
      reason_category: getValidReasonCategory(input),
      signingMetadata: {
        packageId: input.packageId,
        canonicalization: input.payload.canonicalization,
        contentRef: input.payload.contentRef,
        algorithm: input.algorithm,
        keyId: input.keyId,
        signature: STRUCTURAL_SIGNATURE_PLACEHOLDER,
        nonClaims: cloneJson(candidate.nonClaims)
      }
    };

    if (input.payload.payloadDigest !== undefined) {
      result.signingMetadata.payloadDigest = input.payload.payloadDigest;
    }
    if (input.keyMetadata !== undefined) {
      result.signingMetadata.keyMetadata = cloneJson(input.keyMetadata);
    }
    return result;
  } catch {
    return failure('invalid_json_value');
  }
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_ALGORITHM,
  STRUCTURAL_SIGNATURE_PLACEHOLDER,
  validateStructuralSigningInput,
  prepareStructuralSigning
};
