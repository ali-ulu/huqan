'use strict';

const { types } = require('node:util');

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function jsonValue(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every(item => jsonValue(item, depth + 1));
  return plain(value) && Object.keys(value).length <= 64
    && Object.values(value).every(item => jsonValue(item, depth + 1));
}

function onlyKeys(value, keys) {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key).enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

// Reject executable properties before reading values or serializing input.
function safeData(value, seen = new Set(), depth = 0) {
  if (depth > 10) return false;
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  if (types.isProxy(value)) return false;
  if (seen.has(value) || (Array.isArray(value)
    ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value))) return false;
  seen.add(value);
  const ok = Reflect.ownKeys(value).every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(String(key))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && key !== 'toJSON' && descriptor.enumerable
      && Object.hasOwn(descriptor, 'value') && safeData(descriptor.value, seen, depth + 1);
  });
  seen.delete(value);
  return ok;
}

module.exports = { plain, jsonValue, onlyKeys, safeData };
