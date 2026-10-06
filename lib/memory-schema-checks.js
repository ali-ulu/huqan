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
// numbers, array holes, accessors and hidden keys are refused rather than
// dropped or nulled. Shared by the KnowledgeObject and CognitiveMessage
// schemas, which both store caller content.
function isLosslessJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    // Index by index: every() skips holes, which JSON turns into null; a hole
    // reads as undefined here and is refused.
    for (let i = 0; i < value.length; i += 1) if (!isLosslessJson(value[i])) return false;
    return true;
  }
  if (!isPlainObject(value)) return false;
  // JSON drops symbol and non-enumerable keys; an accessor has no data value
  // here and is refused as undefined.
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor.enumerable && isLosslessJson(descriptor.value);
  });
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
