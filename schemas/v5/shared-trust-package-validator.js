'use strict';

const schema = require('./shared-trust-package.schema.json');
const {
  VALID_SUBJECT_TYPES,
  VALID_VERDICT_STATUSES,
  makeError,
  isPlainObject,
  isNonEmptyString,
  readJson,
  validateObjectKeys,
  validateRequiredString,
} = require('./shared-trust-package-guards');
const {
  validateEvidence,
  validateNonClaims,
  validateReceiptSourceSnapshot,
  validateReceiptRouteReceipt,
  validateTopLevelRouteReceipt,
  validateReasoningMetadata,
} = require('./shared-trust-package-sections');

const SHARED_TRUST_PACKAGE_SCHEMA_VERSION = 'v5-shared-trust-package/v0.1';

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
    if (validateRequiredString(candidate.subject, 'type', 'subject.type', errors)
      && !VALID_SUBJECT_TYPES.has(candidate.subject.type)) {
      errors.push(makeError('invalid_enum_value', 'subject.type', 'subject.type is not allowed.'));
    }
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

  if (Object.hasOwn(candidate, 'routeReceipt')) {
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
