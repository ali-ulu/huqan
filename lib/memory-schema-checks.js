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
  pushError,
  result,
  validateProvenance,
  validateRequiredArray,
  validateRequiredObject,
  validateRequiredString,
  validateTimestamp,
};
