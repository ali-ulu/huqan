'use strict';

const {
  VALID_VERDICT_STATUSES,
  VALID_REASONING_STATUSES,
  SOURCE_SNAPSHOT_VERSION_CONST,
  SOURCE_SNAPSHOT_ALGORITHM_CONST,
  SOURCE_SNAPSHOT_HEX_PATTERN,
  makeError,
  isPlainObject,
  isNonEmptyString,
  isNonNegativeInteger,
  isPrimitiveOrNull,
  validateObjectKeys,
  validateRequiredString,
} = require('./shared-trust-package-guards');

function validateEvidence(evidence, errors) {
  if (!Array.isArray(evidence)) {
    errors.push(makeError('invalid_array', 'evidence', 'evidence must be an array.'));
    return;
  }

  for (const [index, item] of evidence.entries()) {
    const path = `evidence[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(makeError('invalid_object', path, `${path} must be an object.`));
      continue;
    }

    validateObjectKeys(item, new Set(['type', 'ref']), path, errors);
    validateRequiredString(item, 'type', `${path}.type`, errors);
    validateRequiredString(item, 'ref', `${path}.ref`, errors);
  }
}

function validateNonClaims(nonClaims, errors) {
  if (!Array.isArray(nonClaims) || nonClaims.length === 0) {
    errors.push(makeError('missing_required_field', 'nonClaims', 'nonClaims must be a non-empty array.'));
    return;
  }

  for (const [index, value] of nonClaims.entries()) {
    if (!isNonEmptyString(value)) {
      errors.push(makeError('invalid_string', `nonClaims[${index}]`, `nonClaims[${index}] must be a non-empty string.`));
    }
  }
}

/**
 * `receipt.sourceSnapshot` — immutable source binding, fail-closed.
 *
 * Contract: `docs/v5/v5-immutable-source-snapshot-contract.md` (§2).
 * One nested object inside `receipt` (same location discipline as
 * `routeReceipt`), exact key set
 * `{ snapshotId, snapshotVersion, hash, algorithm }`, all four required,
 * no additional properties. The snapshot is a content binding only:
 * it carries the source view — it never re-hashes, re-versions, or
 * "fixes up" what was supplied. A package carrying it asserts the
 * source looked like that view when the package was written.
 *
 * `snapshotVersion` is pinned to the V4 external-source-snapshot
 * version string — the wiring PR may not introduce a new version
 * family. `algorithm` is fixed to `sha256`; `hash` is the hex digest
 * over the canonical binding view of the snapshot, 64 lowercase hex
 * characters.
 */
function validateReceiptSourceSnapshot(sourceSnapshot, errors) {
  if (!isPlainObject(sourceSnapshot)) {
    errors.push(makeError('invalid_object', 'receipt.sourceSnapshot', 'receipt.sourceSnapshot must be an object.'));
    return;
  }

  validateObjectKeys(
    sourceSnapshot,
    new Set(['snapshotId', 'snapshotVersion', 'hash', 'algorithm']),
    'receipt.sourceSnapshot',
    errors
  );
  validateRequiredString(sourceSnapshot, 'snapshotId', 'receipt.sourceSnapshot.snapshotId', errors);

  if (sourceSnapshot.snapshotVersion !== SOURCE_SNAPSHOT_VERSION_CONST) {
    errors.push(makeError(
      'invalid_enum_value',
      'receipt.sourceSnapshot.snapshotVersion',
      `receipt.sourceSnapshot.snapshotVersion must be ${SOURCE_SNAPSHOT_VERSION_CONST}.`
    ));
  }

  if (sourceSnapshot.algorithm !== SOURCE_SNAPSHOT_ALGORITHM_CONST) {
    errors.push(makeError(
      'invalid_enum_value',
      'receipt.sourceSnapshot.algorithm',
      `receipt.sourceSnapshot.algorithm must be ${SOURCE_SNAPSHOT_ALGORITHM_CONST}.`
    ));
  }

  if (typeof sourceSnapshot.hash !== 'string' || !SOURCE_SNAPSHOT_HEX_PATTERN.test(sourceSnapshot.hash)) {
    errors.push(makeError(
      'invalid_string',
      'receipt.sourceSnapshot.hash',
      'receipt.sourceSnapshot.hash must be a 64-character lowercase hex sha256 digest.'
    ));
  }
}

function validateReceiptRouteReceipt(routeReceipt, errors) {
  if (!isPlainObject(routeReceipt)) {
    errors.push(makeError('invalid_object', 'receipt.routeReceipt', 'receipt.routeReceipt must be an object.'));
    return;
  }

  validateObjectKeys(routeReceipt, new Set(['routeId', 'hopCount', 'metadata']), 'receipt.routeReceipt', errors);
  validateRequiredString(routeReceipt, 'routeId', 'receipt.routeReceipt.routeId', errors);

  if (!Object.hasOwn(routeReceipt, 'hopCount') || !isNonNegativeInteger(routeReceipt.hopCount)) {
    errors.push(makeError('missing_required_field', 'receipt.routeReceipt.hopCount', 'receipt.routeReceipt.hopCount is required and must be a non-negative integer.'));
  }

  if (!Object.hasOwn(routeReceipt, 'metadata') || !isPlainObject(routeReceipt.metadata) || Object.keys(routeReceipt.metadata).length === 0) {
    errors.push(makeError('missing_required_field', 'receipt.routeReceipt.metadata', 'receipt.routeReceipt.metadata is required and must be a non-empty object.'));
    return;
  }

  for (const [key, value] of Object.entries(routeReceipt.metadata)) {
    if (!isPrimitiveOrNull(value)) {
      errors.push(makeError('invalid_metadata_value', `receipt.routeReceipt.metadata.${key}`, `receipt.routeReceipt.metadata.${key} must be a string, number, boolean, or null.`));
    }
  }
}

function validateTopLevelRouteReceipt(routeReceipt, errors) {
  if (!isPlainObject(routeReceipt)) {
    errors.push(makeError('invalid_object', 'routeReceipt', 'routeReceipt must be an object.'));
    return;
  }

  validateObjectKeys(routeReceipt, new Set(['routeId', 'hops']), 'routeReceipt', errors);
  validateRequiredString(routeReceipt, 'routeId', 'routeReceipt.routeId', errors);

  if (!Object.hasOwn(routeReceipt, 'hops') || !Array.isArray(routeReceipt.hops) || routeReceipt.hops.length === 0) {
    errors.push(makeError('missing_required_field', 'routeReceipt.hops', 'routeReceipt.hops is required and must be a non-empty array.'));
    return;
  }

  for (const [index, hop] of routeReceipt.hops.entries()) {
    const hopPath = `routeReceipt.hops[${index}]`;
    if (!isPlainObject(hop)) {
      errors.push(makeError('invalid_object', hopPath, `${hopPath} must be an object.`));
      continue;
    }

    validateObjectKeys(hop, new Set(['hopId', 'agentId', 'workspaceId', 'verdictStatus', 'receiptId']), hopPath, errors);
    validateRequiredString(hop, 'hopId', `${hopPath}.hopId`, errors);
    validateRequiredString(hop, 'agentId', `${hopPath}.agentId`, errors);
    validateRequiredString(hop, 'workspaceId', `${hopPath}.workspaceId`, errors);
    validateRequiredString(hop, 'receiptId', `${hopPath}.receiptId`, errors);

    if (!isNonEmptyString(hop.verdictStatus)) {
      errors.push(makeError('missing_required_field', `${hopPath}.verdictStatus`, `${hopPath}.verdictStatus is required.`));
    } else if (!VALID_VERDICT_STATUSES.has(hop.verdictStatus)) {
      errors.push(makeError('invalid_enum_value', `${hopPath}.verdictStatus`, `${hopPath}.verdictStatus is not allowed.`));
    }
  }
}

function validateReasoningMetadata(reasoningMetadata, errors) {
  if (!isPlainObject(reasoningMetadata)) {
    errors.push(makeError('invalid_object', 'reasoningMetadata', 'reasoningMetadata must be an object.'));
    return;
  }

  validateObjectKeys(reasoningMetadata, new Set(['traceId', 'summary', 'steps']), 'reasoningMetadata', errors);
  validateRequiredString(reasoningMetadata, 'traceId', 'reasoningMetadata.traceId', errors);

  if (!Object.hasOwn(reasoningMetadata, 'steps') || !Array.isArray(reasoningMetadata.steps) || reasoningMetadata.steps.length === 0) {
    errors.push(makeError('missing_required_field', 'reasoningMetadata.steps', 'reasoningMetadata.steps is required and must be a non-empty array.'));
    return;
  }

  for (const [index, step] of reasoningMetadata.steps.entries()) {
    const stepPath = `reasoningMetadata.steps[${index}]`;
    if (!isPlainObject(step)) {
      errors.push(makeError('invalid_object', stepPath, `${stepPath} must be an object.`));
      continue;
    }

    validateObjectKeys(step, new Set(['stepId', 'type', 'status']), stepPath, errors);
    validateRequiredString(step, 'stepId', `${stepPath}.stepId`, errors);
    validateRequiredString(step, 'type', `${stepPath}.type`, errors);

    if (!isNonEmptyString(step.status)) {
      errors.push(makeError('missing_required_field', `${stepPath}.status`, `${stepPath}.status is required.`));
    } else if (!VALID_REASONING_STATUSES.has(step.status)) {
      errors.push(makeError('invalid_enum_value', `${stepPath}.status`, `${stepPath}.status is not allowed.`));
    }
  }
}

module.exports = {
  validateEvidence,
  validateNonClaims,
  validateReceiptSourceSnapshot,
  validateReceiptRouteReceipt,
  validateTopLevelRouteReceipt,
  validateReasoningMetadata,
};
