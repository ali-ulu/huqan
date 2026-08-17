'use strict';

const fs = require('node:fs');
const schema = require('./shared-trust-package.schema.json');

const SHARED_TRUST_PACKAGE_SCHEMA_VERSION = 'v5-shared-trust-package/v0.1';
const VALID_VERDICT_STATUSES = new Set(['allow', 'review', 'dry_run_only', 'block']);
const VALID_REASONING_STATUSES = new Set(['allow', 'review', 'dry_run_only', 'block', 'unknown']);

function makeError(code, path, message) {
  return { code, path, message };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPrimitiveOrNull(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function childPath(basePath, key) {
  return basePath ? `${basePath}.${key}` : `/${key}`;
}

function validateObjectKeys(object, allowedKeys, basePath, errors) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      const path = childPath(basePath, key);
      errors.push(makeError('unknown_field', path, `${path} is not allowed.`));
    }
  }
}

function validateRequiredString(object, field, path, errors) {
  if (!isPlainObject(object) || !isNonEmptyString(object[field])) {
    errors.push(makeError('missing_required_field', path, `${path} is required.`));
    return false;
  }
  return true;
}

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

const SOURCE_SNAPSHOT_VERSION_CONST = 'huqan.external-source-snapshot.v1';
const SOURCE_SNAPSHOT_ALGORITHM_CONST = 'sha256';
const SOURCE_SNAPSHOT_HEX_PATTERN = /^[a-f0-9]{64}$/;

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

function validateSharedTrustPackage(candidate) {
  const errors = [];

  if (!isPlainObject(candidate)) {
    return {
      valid: false,
      errors: [makeError('invalid_object', '/', 'Shared Trust Package must be an object.')]
    };
  }

  const rootAllowedKeys = new Set(Object.keys(schema.properties));
  validateObjectKeys(candidate, rootAllowedKeys, '', errors);

  for (const field of schema.required) {
    if (!Object.hasOwn(candidate, field)) {
      errors.push(makeError('missing_required_field', field, `${field} is required.`));
    }
  }

  if (candidate.schemaVersion !== SHARED_TRUST_PACKAGE_SCHEMA_VERSION) {
    errors.push(makeError('invalid_schema_version', 'schemaVersion', `schemaVersion must be ${SHARED_TRUST_PACKAGE_SCHEMA_VERSION}.`));
  }

  validateRequiredString(candidate, 'packageId', 'packageId', errors);

  if (!isPlainObject(candidate.issuer)) {
    errors.push(makeError('invalid_object', 'issuer', 'issuer must be an object.'));
  } else {
    validateObjectKeys(candidate.issuer, new Set(['agentId', 'workspaceId']), 'issuer', errors);
    validateRequiredString(candidate.issuer, 'agentId', 'issuer.agentId', errors);
    validateRequiredString(candidate.issuer, 'workspaceId', 'issuer.workspaceId', errors);
  }

  if (!isPlainObject(candidate.subject)) {
    errors.push(makeError('invalid_object', 'subject', 'subject must be an object.'));
  } else {
    validateObjectKeys(candidate.subject, new Set(['type', 'id']), 'subject', errors);
    validateRequiredString(candidate.subject, 'type', 'subject.type', errors);
    validateRequiredString(candidate.subject, 'id', 'subject.id', errors);
  }

  if (!isPlainObject(candidate.verdict)) {
    errors.push(makeError('invalid_object', 'verdict', 'verdict must be an object.'));
  } else {
    validateObjectKeys(candidate.verdict, new Set(['status', 'reason']), 'verdict', errors);
    if (!isNonEmptyString(candidate.verdict.status)) {
      errors.push(makeError('missing_required_field', 'verdict.status', 'verdict.status is required.'));
    } else if (!VALID_VERDICT_STATUSES.has(candidate.verdict.status)) {
      errors.push(makeError('invalid_enum_value', 'verdict.status', 'verdict.status is not allowed.'));
    }
    if (Object.hasOwn(candidate.verdict, 'reason') && typeof candidate.verdict.reason !== 'string') {
      errors.push(makeError('invalid_string', 'verdict.reason', 'verdict.reason must be a string.'));
    }
  }

  if (!isPlainObject(candidate.receipt)) {
    errors.push(makeError('invalid_object', 'receipt', 'receipt must be an object.'));
  } else {
    validateObjectKeys(candidate.receipt, new Set(['receiptId', 'issuedAt', 'routeReceipt', 'sourceSnapshot']), 'receipt', errors);
    validateRequiredString(candidate.receipt, 'receiptId', 'receipt.receiptId', errors);
    validateRequiredString(candidate.receipt, 'issuedAt', 'receipt.issuedAt', errors);

    if (Object.hasOwn(candidate.receipt, 'issuedAt') && Number.isNaN(Date.parse(candidate.receipt.issuedAt))) {
      errors.push(makeError('invalid_date_time', 'receipt.issuedAt', 'receipt.issuedAt must be a parseable timestamp.'));
    }

    if (Object.hasOwn(candidate.receipt, 'routeReceipt')) {
      validateReceiptRouteReceipt(candidate.receipt.routeReceipt, errors);
    }

    if (Object.hasOwn(candidate.receipt, 'sourceSnapshot')) {
      validateReceiptSourceSnapshot(candidate.receipt.sourceSnapshot, errors);
    }
  }

  validateEvidence(candidate.evidence, errors);
  validateNonClaims(candidate.nonClaims, errors);

  if (candidate.subject && candidate.subject.type === 'route_receipt') {
    if (!Object.hasOwn(candidate.receipt || {}, 'routeReceipt')) {
      errors.push(makeError('missing_required_field', 'receipt.routeReceipt', 'receipt.routeReceipt is required for route_receipt packages.'));
    }
  }

  if (candidate.subject && candidate.subject.type === 'route_receipt_chain') {
    validateTopLevelRouteReceipt(candidate.routeReceipt, errors);
  }

  if (candidate.subject && candidate.subject.type === 'reasoning_metadata') {
    if (!Object.hasOwn(candidate, 'reasoningMetadata')) {
      errors.push(makeError('missing_required_field', 'reasoningMetadata', 'reasoningMetadata is required for reasoning_metadata packages.'));
    } else {
      validateReasoningMetadata(candidate.reasoningMetadata, errors);
    }
  }

  if (candidate.reasoningMetadata !== undefined && candidate.subject?.type !== 'reasoning_metadata') {
    validateReasoningMetadata(candidate.reasoningMetadata, errors);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateSharedTrustPackageFile(filePath) {
  try {
    return validateSharedTrustPackage(readJson(filePath));
  } catch (error) {
    return {
      valid: false,
      errors: [makeError('read_error', '/', error.message)]
    };
  }
}

module.exports = {
  SHARED_TRUST_PACKAGE_SCHEMA_VERSION,
  validateSharedTrustPackage,
  validateSharedTrustPackageFile
};
