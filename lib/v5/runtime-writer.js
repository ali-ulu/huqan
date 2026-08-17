'use strict';

const SUPPORTED_SCHEMA_VERSION = 'v5.shared_trust_package.writer_input.v1';

const ALLOWED_VERDICT_STATUSES = new Set([
  'allow',
  'review',
  'dry_run_only',
  'block'
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function block(reasonCategory) {
  return {
    ok: false,
    verdict: 'BLOCK',
    reason_category: reasonCategory
  };
}

function hasDisallowedClaim(input) {
  const claims = isPlainObject(input.claims) ? input.claims : {};

  if (claims.signed === true || claims.signatureRuntime) {
    return 'unsigned_but_claimed_signed';
  }

  if (
    claims.runtimeReaderImplemented === true ||
    claims.readerImplemented === true ||
    claims.exportImplemented === true ||
    claims.runtimeExportImplemented === true
  ) {
    return 'runtime_reader_claim';
  }

  if (claims.verificationRuntime === true || claims.verificationRuntimeImplemented === true) {
    return 'verification_runtime_claim';
  }

  if (claims.a2aTransport === true || claims.a2aTransportEnabled === true) {
    return 'a2a_transport_claim';
  }

  if (claims.connectorEnforcement === true || claims.connectorEnforcementImplemented === true) {
    return 'connector_enforcement_claim';
  }

  if (claims.marketplaceReady === true || claims.marketplaceImplemented === true) {
    return 'marketplace_claim';
  }

  if (claims.agentActionPolicyEngine === true || claims.agentActionPolicyEngineEnabled === true) {
    return 'agentaction_policy_engine_claim';
  }

  return null;
}

function validateRouteReceipt(routeReceipt) {
  if (routeReceipt === undefined) {
    return null;
  }

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

    if (!isNonEmptyString(routeReceipt.handoff.from) || !isNonEmptyString(routeReceipt.handoff.to)) {
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

  if (reasoning.modelGenerated !== undefined && typeof reasoning.modelGenerated !== 'boolean') {
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

  if (provenance.traceId !== undefined && !isNonEmptyString(provenance.traceId)) {
    return 'malformed_provenance_metadata';
  }

  if (provenance.receiptId !== undefined && !isNonEmptyString(provenance.receiptId)) {
    return 'malformed_provenance_metadata';
  }

  if (provenance.source !== undefined && !isNonEmptyString(provenance.source)) {
    return 'malformed_provenance_metadata';
  }

  return null;
}

// Pinned to the V4 external-source-snapshot version string; a writer may
// not introduce a new snapshot version family. The algorithm is fixed to
// sha256, the single allowed digest algorithm for this unit.
const SOURCE_SNAPSHOT_VERSION_CONST = 'huqan.external-source-snapshot.v1';
const SOURCE_SNAPSHOT_ALGORITHM_CONST = 'sha256';
const SOURCE_SNAPSHOT_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Optional bounded `sourceSnapshot` input — immutable source binding,
 * fail-closed. Contract: docs/v5/v5-immutable-source-snapshot-contract.md
 * (the nested `receipt.sourceSnapshot` shape, same location discipline as
 * route receipt metadata).
 *
 * Carry or reject, never "fix up": the writer may not re-hash,
 * re-version, or correct a supplied snapshot. A snapshot the writer
 * cannot validate is rejected whole at write time; no partial or
 * corrected snapshot is ever emitted. Absent input stays absent.
 */
function validateSourceSnapshot(sourceSnapshot) {
  if (sourceSnapshot === undefined) {
    return null;
  }

  if (!isPlainObject(sourceSnapshot)) {
    return 'malformed_source_snapshot';
  }

  const allowedKeys = new Set(['snapshotId', 'snapshotVersion', 'hash', 'algorithm']);
  for (const key of Object.keys(sourceSnapshot)) {
    if (!allowedKeys.has(key)) {
      return 'malformed_source_snapshot';
    }
  }

  if (!isNonEmptyString(sourceSnapshot.snapshotId)) {
    return 'malformed_source_snapshot';
  }

  if (sourceSnapshot.snapshotVersion !== SOURCE_SNAPSHOT_VERSION_CONST) {
    return 'malformed_source_snapshot';
  }

  if (sourceSnapshot.algorithm !== SOURCE_SNAPSHOT_ALGORITHM_CONST) {
    return 'malformed_source_snapshot';
  }

  if (typeof sourceSnapshot.hash !== 'string' || !SOURCE_SNAPSHOT_HEX_PATTERN.test(sourceSnapshot.hash)) {
    return 'malformed_source_snapshot';
  }

  return null;
}

function validateWriterInput(input) {
  if (!isPlainObject(input)) {
    return block('invalid_writer_input');
  }

  if (input.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return block('unsupported_schema_version');
  }

  if (!isNonEmptyString(input.packageId)) {
    return block('missing_trust_package_identity');
  }

  if (!isPlainObject(input.issuer)) {
    return block('missing_issuer_identity');
  }

  if (!isNonEmptyString(input.issuer.agentId)) {
    return block('missing_agent_identity');
  }

  if (!isNonEmptyString(input.issuer.workspaceId)) {
    return block('missing_workspace_identity');
  }

  if (!isPlainObject(input.subject) || !isNonEmptyString(input.subject.type) || !isNonEmptyString(input.subject.id)) {
    return block('missing_subject_reference');
  }

  if (!isPlainObject(input.verdict) || !isNonEmptyString(input.verdict.status)) {
    return block('missing_verdict_metadata');
  }

  if (!ALLOWED_VERDICT_STATUSES.has(input.verdict.status)) {
    return block('unsupported_verdict_status');
  }

  const disallowedClaim = hasDisallowedClaim(input);
  if (disallowedClaim) {
    return block(disallowedClaim);
  }

  const routeReceiptError = validateRouteReceipt(input.routeReceipt);
  if (routeReceiptError) {
    return block(routeReceiptError);
  }

  const reasoningError = validateReasoning(input.reasoning);
  if (reasoningError) {
    return block(reasoningError);
  }

  const provenanceError = validateProvenance(input.provenance);
  if (provenanceError) {
    return block(provenanceError);
  }

  const sourceSnapshotError = validateSourceSnapshot(input.sourceSnapshot);
  if (sourceSnapshotError) {
    return block(sourceSnapshotError);
  }

  return null;
}

function buildPackage(input) {
  const output = {
    schemaVersion: input.schemaVersion,
    packageId: input.packageId,
    issuer: {
      agentId: input.issuer.agentId,
      workspaceId: input.issuer.workspaceId
    },
    subject: {
      type: input.subject.type,
      id: input.subject.id
    },
    verdict: cloneJson(input.verdict),
    nonClaims: Array.isArray(input.nonClaims) ? cloneJson(input.nonClaims) : []
  };

  if (input.routeReceipt !== undefined) {
    output.routeReceipt = cloneJson(input.routeReceipt);
  }

  if (input.reasoning !== undefined) {
    output.reasoning = cloneJson(input.reasoning);
  }

  if (input.provenance !== undefined) {
    output.provenance = cloneJson(input.provenance);
  }

  // Carry or reject: the supplied source snapshot is transported as-is
  // under the single writable shape (`receipt.sourceSnapshot`), with no
  // re-hashing, re-versioning, or field correction. The immutable anchor
  // is written exactly as the writer received it.
  if (input.sourceSnapshot !== undefined) {
    output.sourceSnapshot = {
      snapshotId: input.sourceSnapshot.snapshotId,
      snapshotVersion: input.sourceSnapshot.snapshotVersion,
      hash: input.sourceSnapshot.hash,
      algorithm: input.sourceSnapshot.algorithm
    };
  }

  return output;
}

function getAcceptedReasonCategory(input) {
  if (input.routeReceipt !== undefined) {
    return 'valid_route_receipt_metadata';
  }

  if (input.reasoning !== undefined) {
    return 'valid_reasoning_metadata';
  }

  if (input.provenance !== undefined) {
    return 'valid_provenance_metadata';
  }

  if (input.sourceSnapshot !== undefined) {
    return 'valid_source_snapshot_metadata';
  }

  return 'valid_minimal_writer_input';
}

function writeRuntimePackage(input) {
  const invalid = validateWriterInput(input);
  if (invalid) {
    return invalid;
  }

  return {
    ok: true,
    verdict: 'ACCEPT',
    reason_category: getAcceptedReasonCategory(input),
    package: buildPackage(input)
  };
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  validateWriterInput,
  writeRuntimePackage
};
