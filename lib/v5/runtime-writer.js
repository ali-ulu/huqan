'use strict';

// Local V5 shared trust package writer: validates writer input and builds the
// package. Guards live in runtime-writer-guards.js, section validation in
// runtime-writer-sections.js (#2206).

const { isPlainObject } = require('../is-plain-object');
const { ALLOWED_VERDICT_STATUSES, SUPPORTED_SCHEMA_VERSION, block, cloneJson, findJsonSafetyError, hasDisallowedClaim, isNonEmptyString } = require('./runtime-writer-guards');
const { validateProvenance, validateReasoning, validateRouteReceipt, validateSourceSnapshot } = require('./runtime-writer-sections');

function validateWriterInput(input) {
  if (!isPlainObject(input)) {
    return block('invalid_writer_input');
  }

  const jsonSafetyError = findJsonSafetyError(input);
  if (jsonSafetyError) {
    return block(jsonSafetyError);
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
  // #1298: findJsonSafetyError() in validateWriterInput() is the primary
  // guard, but wrap the whole boundary too -- matching
  // structural-signing-helper.js's prepareStructuralSigning() -- so a build
  // step that throws for any other reason still fails closed as a
  // structured BLOCK instead of an uncaught exception.
  try {
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
  } catch (_error) {
    return block('invalid_json_value');
  }
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  validateWriterInput,
  writeRuntimePackage
};
