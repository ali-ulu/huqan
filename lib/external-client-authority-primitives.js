'use strict';

/**
 * Generic own-property/plain-object validation primitives shared by
 * lib/external-client-authority.js and
 * lib/external-client-trusted-key-snapshot.js (split out in #2266). These
 * carry no authority-specific knowledge -- they only enforce "own data
 * property, not inherited/accessor/symbol" and coerce+validate primitive
 * shapes, raising the caller-supplied error code on failure.
 */

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  throw error;
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(object, key, code, message) {
  if (!plain(object)) fail(code, message, { field: key });
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail(code, message, { field: key });
  }
  return descriptor.value;
}

function exactText(object, key, code, message) {
  const value = own(object, key, code, message);
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(code, message, { field: key });
  return normalized;
}

function instant(value, code, message, details = {}) {
  if (typeof value !== 'string' || value.trim() !== value) fail(code, message, details);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code, message, details);
  }
  return milliseconds;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

module.exports = {
  fail, plain, own, exactText, instant, freeze,
};
