'use strict';

// #2206: validation of the writer input's sections: route receipt, reasoning,
// provenance and the pinned external source snapshot.

const { isPlainObject } = require('../is-plain-object');
const { isNonEmptyString } = require('./runtime-writer-guards');

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

module.exports = {
  validateProvenance,
  validateReasoning,
  validateRouteReceipt,
  validateSourceSnapshot,
};
