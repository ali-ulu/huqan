'use strict';

const fs = require('node:fs');

const VALID_VERDICT_STATUSES = new Set(['allow', 'review', 'dry_run_only', 'block']);
const VALID_REASONING_STATUSES = new Set(['allow', 'review', 'dry_run_only', 'block', 'unknown']);
const VALID_SUBJECT_TYPES = new Set(['agent_action', 'change', 'tool_call', 'route_receipt', 'route_receipt_chain', 'reasoning_metadata']);

const SOURCE_SNAPSHOT_VERSION_CONST = 'huqan.external-source-snapshot.v1';
const SOURCE_SNAPSHOT_ALGORITHM_CONST = 'sha256';
const SOURCE_SNAPSHOT_HEX_PATTERN = /^[a-f0-9]{64}$/;

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

module.exports = {
  VALID_VERDICT_STATUSES,
  VALID_REASONING_STATUSES,
  VALID_SUBJECT_TYPES,
  SOURCE_SNAPSHOT_VERSION_CONST,
  SOURCE_SNAPSHOT_ALGORITHM_CONST,
  SOURCE_SNAPSHOT_HEX_PATTERN,
  makeError,
  isPlainObject,
  isNonEmptyString,
  isNonNegativeInteger,
  isPrimitiveOrNull,
  readJson,
  childPath,
  validateObjectKeys,
  validateRequiredString,
};
