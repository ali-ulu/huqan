// #2174: the field-level checks every memory validator is built from --
// JSON safety, timestamps, required strings/objects/arrays, provenance.

const { isPlainObject } = require('./is-plain-object');

function isJsonSafe(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch (_) {
    return false;
  }
}

// Stricter than isJsonSafe (stringify does not throw): content must survive
// JSON unchanged, so functions, undefined, symbols, bigints, non-finite
// numbers, array holes, accessors, hidden keys and cycles are refused rather
// than dropped, nulled or thrown on. Shared by the KnowledgeObject and
// CognitiveMessage schemas, which both store caller content.
//
// `seen` holds the objects on the current path only: a cycle is refused (JSON
// would throw a RangeError), while a shared, non-cyclic reference stays valid.
function isLosslessJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return isLosslessArray(value, seen);
    if (!isPlainObject(value)) return false;
    // JSON drops symbol and non-enumerable keys, and an accessor has no data
    // value; only own enumerable data properties are accepted.
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && descriptor.enumerable && 'value' in descriptor && isLosslessJson(descriptor.value, seen);
    });
  } finally {
    seen.delete(value);
  }
}

// An array is lossless only when it is a plain Array, every index is an own
// data property (a hole serializes as null; an accessor is read twice), and no
// other own property -- a `toJSON`, say -- could change serialization. The
// object branch's rule, applied to indices.
function isLosslessArray(value, seen) {
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (key === 'length') {
      if (descriptor.enumerable) return false;
      continue;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return false;
    if (!descriptor.enumerable || !('value' in descriptor) || !isLosslessJson(descriptor.value, seen)) return false;
  }
  // Every index must be an own data property: a hole serializes as null.
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) return false;
  }
  return true;
}

function pushError(errors, code, field, message) {
  errors.push({ code, field, message });
}

function result(type, warnings, errors) {
  return { ok: errors.length === 0, type, warnings, errors };
}

function validateTimestamp(errors, value, field) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} must be a parseable timestamp`);
    return false;
  }
  return true;
}

function validateRequiredString(errors, object, field, errorField = field) {
  if (!isPlainObject(object) || typeof object[field] !== 'string' || !object[field].trim()) {
    pushError(errors, 'VALIDATION_ERROR', errorField, `${errorField} is required`);
    return false;
  }
  return true;
}

function validateRequiredObject(errors, object, field) {
  if (!isPlainObject(object) || !isPlainObject(object[field])) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} is required`);
    return false;
  }
  return true;
}

function validateRequiredArray(errors, object, field) {
  if (!isPlainObject(object) || !Array.isArray(object[field])) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} is required`);
    return false;
  }
  return true;
}

function validateProvenance(provenance, errors, fieldPrefix = 'provenance') {
  if (!isPlainObject(provenance)) {
    pushError(errors, 'VALIDATION_ERROR', fieldPrefix, `${fieldPrefix} is required`);
    return false;
  }
  validateRequiredString(errors, provenance, 'provenanceId', `${fieldPrefix}.provenanceId`);
  validateRequiredString(errors, provenance, 'sourceRef', `${fieldPrefix}.sourceRef`);
  validateRequiredString(errors, provenance, 'sourceTitle', `${fieldPrefix}.sourceTitle`);
  validateRequiredString(errors, provenance, 'sourceType', `${fieldPrefix}.sourceType`);
  validateRequiredString(errors, provenance, 'actor', `${fieldPrefix}.actor`);
  validateRequiredString(errors, provenance, 'timestamp', `${fieldPrefix}.timestamp`);
  validateRequiredString(errors, provenance, 'workspaceId', `${fieldPrefix}.workspaceId`);
  validateRequiredString(errors, provenance, 'trustPolicyVersion', `${fieldPrefix}.trustPolicyVersion`);
  validateTimestamp(errors, provenance.timestamp, `${fieldPrefix}.timestamp`);
  if (typeof provenance.confidence !== 'number' || Number.isNaN(provenance.confidence) || provenance.confidence < 0 || provenance.confidence > 1) {
    pushError(errors, 'VALIDATION_ERROR', `${fieldPrefix}.confidence`, `${fieldPrefix}.confidence must be a number between 0 and 1`);
  }
  if (!isJsonSafe(provenance.metadata ?? null)) {
    pushError(errors, 'VALIDATION_ERROR', `${fieldPrefix}.metadata`, `${fieldPrefix}.metadata must be JSON-safe`);
  }
  return true;
}

module.exports = {
  isJsonSafe,
  isLosslessJson,
  pushError,
  result,
  validateProvenance,
  validateRequiredArray,
  validateRequiredObject,
  validateRequiredString,
  validateTimestamp,
};
