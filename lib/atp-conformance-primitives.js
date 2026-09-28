'use strict';

const { isPlainObject } = require('./is-plain-object');

function isJsonSafe(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeATPValidationError(error, fallbackField = '') {
  if (!error) {
    return { code: 'VALIDATION_ERROR', field: fallbackField, message: 'Unknown validation error' };
  }
  if (typeof error === 'string') {
    return { code: 'VALIDATION_ERROR', field: fallbackField, message: error };
  }
  return {
    code: typeof error.code === 'string' && error.code ? error.code : 'VALIDATION_ERROR',
    field: typeof error.field === 'string' ? error.field : fallbackField,
    message: typeof error.message === 'string' && error.message ? error.message : 'Validation error',
  };
}

function createResult(type, warnings = [], errors = []) {
  return { ok: errors.length === 0, type, warnings, errors };
}

function pushError(errors, code, field, message) {
  errors.push({ code, field, message });
}

function pushRequiredString(errors, obj, field, code = 'VALIDATION_ERROR') {
  if (!isPlainObject(obj) || typeof obj[field] !== 'string' || !obj[field].trim()) {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

function pushRequiredObject(errors, obj, field, code = 'VALIDATION_ERROR') {
  if (!isPlainObject(obj) || obj[field] === undefined || obj[field] === null || typeof obj[field] !== 'object' || Array.isArray(obj[field])) {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

function pushRequiredArray(errors, obj, field, code = 'VALIDATION_ERROR') {
  if (!isPlainObject(obj) || !Array.isArray(obj[field])) {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

function pushRequiredBoolean(errors, obj, field, code = 'VALIDATION_ERROR') {
  if (!isPlainObject(obj) || typeof obj[field] !== 'boolean') {
    pushError(errors, code, field, `${field} is required`);
    return false;
  }
  return true;
}

function validateTimestamp(errors, value, field) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} must be a parseable timestamp`);
    return false;
  }
  return true;
}

function validateConfidence(errors, value, field) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
    pushError(errors, 'VALIDATION_ERROR', field, `${field} must be a number between 0 and 1`);
    return false;
  }
  return true;
}

module.exports = {
  isJsonSafe,
  normalizeATPValidationError,
  createResult,
  pushError,
  pushRequiredString,
  pushRequiredObject,
  pushRequiredArray,
  pushRequiredBoolean,
  validateTimestamp,
  validateConfidence,
};
