'use strict';

const SUPPORTED_SCHEMA_VERSION = 'v5.shared_trust_package.writer_input.v1';
const SUPPORTED_ALGORITHM = 'test-structural-v1';
const STRUCTURAL_SIGNATURE_PLACEHOLDER = 'STRUCTURAL_PLACEHOLDER_NOT_CRYPTOGRAPHIC';

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function blocked(reasonCategory) {
  return {
    ok: false,
    status: 'blocked',
    reason_category: reasonCategory
  };
}

function hasKeyMaterial(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (['privateKey', 'publicKey', 'secret', 'credential', 'token'].includes(key)) {
      return true;
    }

    if (isPlainObject(nestedValue) && hasKeyMaterial(nestedValue)) {
      return true;
    }
  }

  return false;
}

function validateClaims(candidate) {
  if (candidate.claims === undefined) {
    return null;
  }

  if (!isPlainObject(candidate.claims)) {
    return 'unsupported_claim';
  }

  for (const key of Object.keys(candidate.claims)) {
    if (!CLAIM_REASON_CATEGORIES.has(key)) {
      return 'unsupported_claim';
    }

    if (candidate.claims[key] === true) {
      return CLAIM_REASON_CATEGORIES.get(key);
    }
  }

  return null;
}

function getValidReasonCategory(input) {
  if (isPlainObject(input.keyMetadata)) {
    return 'valid_signing_key_metadata';
  }

  if (isNonEmptyString(input.payload.payloadDigest)) {
    return 'valid_signing_payload_metadata';
  }

  return 'valid_signing_shape';
}

function validateStructuralSigningInput(candidate) {
  if (!isPlainObject(candidate)) {
    return blocked('invalid_signing_input');
  }

  if (!isPlainObject(candidate.signingInput)) {
    return blocked('missing_signing_input');
  }

  const input = candidate.signingInput;

  if (input.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return blocked('unsupported_schema_version');
  }

  if (!isNonEmptyString(input.packageId)) {
    return blocked('missing_trust_package_identity');
  }

  if (!isPlainObject(input.payload)) {
    return blocked('missing_signing_payload');
  }

  if (input.payload.canonicalization !== 'json-stable-v1') {
    return blocked('unsupported_canonicalization');
  }

  if (!isNonEmptyString(input.payload.contentRef)) {
    return blocked('missing_signing_payload');
  }

  if (
    input.payload.payloadDigest !== undefined &&
    !isNonEmptyString(input.payload.payloadDigest)
  ) {
    return blocked('malformed_signing_payload_metadata');
  }

  if (!isNonEmptyString(input.keyId)) {
    return blocked('missing_key_identifier');
  }

  if (hasKeyMaterial(input)) {
    return blocked('key_material_forbidden');
  }

  if (input.keyMetadata !== undefined && !isPlainObject(input.keyMetadata)) {
    return blocked('malformed_key_metadata');
  }

  if (input.algorithm !== SUPPORTED_ALGORITHM) {
    return blocked('unsupported_signing_algorithm');
  }

  if (input.signature !== undefined && input.signature !== STRUCTURAL_SIGNATURE_PLACEHOLDER) {
    return blocked('malformed_signature_metadata');
  }

  const claimsError = validateClaims(candidate);
  if (claimsError) {
    return blocked(claimsError);
  }

  if (input.trustStatus !== undefined) {
    return blocked('trust_claim');
  }

  if (!Array.isArray(candidate.nonClaims) || candidate.nonClaims.length === 0) {
    return blocked('missing_non_claims');
  }

  if (!candidate.nonClaims.every(isNonEmptyString)) {
    return blocked('malformed_non_claims');
  }

  return null;
}

function prepareStructuralSigning(candidate) {
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
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_ALGORITHM,
  STRUCTURAL_SIGNATURE_PLACEHOLDER,
  validateStructuralSigningInput,
  prepareStructuralSigning
};
