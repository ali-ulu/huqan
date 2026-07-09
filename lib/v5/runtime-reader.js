'use strict';

const SUPPORTED_SCHEMA_VERSION = 'v5.shared_trust_package.writer_input.v1';

const ALLOWED_VERDICT_STATUSES = new Set([
  'allow',
  'review',
  'dry_run_only',
  'block'
]);

const TRUST_STATUS_VALUES = new Set([
  'trusted',
  'verified',
  'signed',
  'authorized',
  'enforced',
  'marketplace_ready'
]);

const CLAIM_REASON_CATEGORIES = new Map([
  ['runtimeReaderImplemented', 'runtime_reader_claim'],
  ['readerImplemented', 'runtime_reader_claim'],
  ['runtimeExchange', 'runtime_exchange_claim'],
  ['runtimeExchangeEnabled', 'runtime_exchange_claim'],
  ['signed', 'signing_runtime_claim'],
  ['signatureRuntime', 'signing_runtime_claim'],
  ['verificationRuntime', 'verification_runtime_claim'],
  ['verificationRuntimeImplemented', 'verification_runtime_claim'],
  ['a2aTransport', 'a2a_transport_claim'],
  ['a2aTransportEnabled', 'a2a_transport_claim'],
  ['connectorEnforcement', 'connector_enforcement_claim'],
  ['connectorEnforcementImplemented', 'connector_enforcement_claim'],
  ['marketplaceReady', 'marketplace_claim'],
  ['marketplaceImplemented', 'marketplace_claim'],
  ['agentActionPolicyEngine', 'agentaction_policy_engine_claim'],
  ['agentActionPolicyEngineEnabled', 'agentaction_policy_engine_claim']
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

function blocked(status, reasonCategory, path) {
  return {
    ok: false,
    status,
    reason_category: reasonCategory,
    errors: [
      {
        code: reasonCategory,
        path,
        message: `Reader blocked candidate: ${reasonCategory}`
      }
    ]
  };
}

function validateRouteReceipt(routeReceipt) {
  if (!isPlainObject(routeReceipt)) {
    return 'malformed_route_receipt_metadata';
  }

  if (!isNonEmptyString(routeReceipt.routeId)) {
    return 'malformed_route_receipt_metadata';
  }

  if (!Array.isArray(routeReceipt.decisionPath)) {
    return 'malformed_route_receipt_metadata';
  }

  if (!routeReceipt.decisionPath.every(isNonEmptyString)) {
    return 'malformed_route_receipt_metadata';
  }

  if (routeReceipt.handoff !== undefined) {
    if (!isPlainObject(routeReceipt.handoff)) {
      return 'malformed_route_receipt_metadata';
    }

    if (
      !isNonEmptyString(routeReceipt.handoff.from) ||
      !isNonEmptyString(routeReceipt.handoff.to)
    ) {
      return 'malformed_route_receipt_metadata';
    }
  }

  return null;
}

function validateReasoning(reasoning) {
  if (reasoning === undefined) {
    return null;
  }

  if (!isPlainObject(reasoning)) {
    return 'malformed_reasoning_metadata';
  }

  if (!isNonEmptyString(reasoning.summary)) {
    return 'malformed_reasoning_metadata';
  }

  if (!Array.isArray(reasoning.inputsReviewed)) {
    return 'malformed_reasoning_metadata';
  }

  if (!reasoning.inputsReviewed.every(isNonEmptyString)) {
    return 'malformed_reasoning_metadata';
  }

  if (
    reasoning.modelGenerated !== undefined &&
    typeof reasoning.modelGenerated !== 'boolean'
  ) {
    return 'malformed_reasoning_metadata';
  }

  return null;
}

function validateProvenance(provenance) {
  if (provenance === undefined) {
    return null;
  }

  if (!isPlainObject(provenance)) {
    return 'malformed_provenance_metadata';
  }

  for (const field of ['traceId', 'receiptId', 'source']) {
    if (provenance[field] !== undefined && !isNonEmptyString(provenance[field])) {
      return 'malformed_provenance_metadata';
    }
  }

  return null;
}

function validateClaims(candidate) {
  if (candidate.claims === undefined) {
    return null;
  }

  if (!isPlainObject(candidate.claims)) {
    return 'unsupported_claim';
  }

  for (const key of Object.keys(candidate.claims)) {
    if (key === 'routeReceiptSupport') {
      continue;
    }

    if (CLAIM_REASON_CATEGORIES.has(key)) {
      return CLAIM_REASON_CATEGORIES.get(key);
    }

    return 'unsupported_claim';
  }

  return null;
}

function getValidReasonCategory(candidate) {
  if (candidate.routeReceipt !== undefined) {
    return 'valid_route_receipt_metadata';
  }

  if (candidate.reasoning !== undefined) {
    return 'valid_reasoning_metadata';
  }

  if (candidate.provenance !== undefined) {
    return 'valid_provenance_metadata';
  }

  if (Array.isArray(candidate.nonClaims) && candidate.nonClaims.length > 0) {
    const hasBoundary = candidate.nonClaims.some((claim) =>
      typeof claim === 'string' && claim.startsWith('does_not_prove_')
    );

    if (hasBoundary) {
      return 'valid_nonclaims_preserved';
    }
  }

  return 'valid_package_candidate';
}

function validateReaderCandidate(candidate) {
  if (!isPlainObject(candidate)) {
    return blocked('malformed', 'invalid_reader_input', '$');
  }

  if (candidate.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return blocked('unsupported_version', 'unsupported_schema_version', '$.schemaVersion');
  }

  if (!isNonEmptyString(candidate.packageId)) {
    return blocked('missing_required_field', 'missing_trust_package_identity', '$.packageId');
  }

  if (!isPlainObject(candidate.issuer)) {
    return blocked('missing_required_field', 'missing_issuer_identity', '$.issuer');
  }

  if (!isNonEmptyString(candidate.issuer.agentId)) {
    return blocked('missing_required_field', 'missing_agent_identity', '$.issuer.agentId');
  }

  if (!isNonEmptyString(candidate.issuer.workspaceId)) {
    return blocked('missing_required_field', 'missing_workspace_identity', '$.issuer.workspaceId');
  }

  if (
    !isPlainObject(candidate.subject) ||
    !isNonEmptyString(candidate.subject.type) ||
    !isNonEmptyString(candidate.subject.id)
  ) {
    return blocked('missing_required_field', 'missing_subject_reference', '$.subject');
  }

  if (!isPlainObject(candidate.verdict) || !isNonEmptyString(candidate.verdict.status)) {
    return blocked('missing_required_field', 'missing_verdict_metadata', '$.verdict');
  }

  if (TRUST_STATUS_VALUES.has(candidate.verdict.status)) {
    return blocked('unsupported_claim', 'trust_verification_status_claim', '$.verdict.status');
  }

  if (!ALLOWED_VERDICT_STATUSES.has(candidate.verdict.status)) {
    return blocked('unsupported_claim', 'unsupported_verdict_status', '$.verdict.status');
  }

  if (!Array.isArray(candidate.nonClaims)) {
    return blocked('missing_required_field', 'missing_non_claims', '$.nonClaims');
  }

  const claimsError = validateClaims(candidate);
  if (claimsError) {
    return blocked('unsupported_claim', claimsError, '$.claims');
  }

  if (candidate.claims?.routeReceiptSupport === true && candidate.routeReceipt === undefined) {
    return blocked(
      'missing_required_field',
      'missing_route_receipt_metadata',
      '$.routeReceipt'
    );
  }

  const routeReceiptError = candidate.routeReceipt === undefined
    ? null
    : validateRouteReceipt(candidate.routeReceipt);
  if (routeReceiptError) {
    return blocked('malformed', routeReceiptError, '$.routeReceipt');
  }

  const reasoningError = validateReasoning(candidate.reasoning);
  if (reasoningError) {
    return blocked('malformed', reasoningError, '$.reasoning');
  }

  const provenanceError = validateProvenance(candidate.provenance);
  if (provenanceError) {
    return blocked('malformed', provenanceError, '$.provenance');
  }

  return null;
}

function readRuntimePackage(candidate) {
  const invalid = validateReaderCandidate(candidate);
  if (invalid) {
    return invalid;
  }

  return {
    ok: true,
    status: 'readable',
    reason_category: getValidReasonCategory(candidate),
    package: cloneJson(candidate)
  };
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  validateReaderCandidate,
  readRuntimePackage
};
