'use strict';

// #2161: exact-key data snapshots, bounded text, canonical instants and key
// references; every refusal carries a receipt error code.

const { encodeJsonStableV1 } = require('./cryptographic-profile-contract');
const { isPlainObject } = require('../is-plain-object');
const { KEY_REFERENCE_CONTROL_PATTERN, KEY_REFERENCE_PATH_PATTERN, KEY_REFERENCE_SCHEME_PATTERN, KEY_REFERENCE_WHITESPACE_PATTERN, TIMESTAMP_PATTERN, fail } = require('./public-trust-receipt-contract');

function snapshotDataObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainObject(value)) return null;
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (_) {
    return null;
  }
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) return null;
  for (const required of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, required)) return null;
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function hasExactDataKeys(value, expectedKeys) {
  const snapshot = snapshotDataObject(value, new Set(expectedKeys), expectedKeys);
  return snapshot !== null && Reflect.ownKeys(snapshot).length === expectedKeys.length;
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function boundedText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && value.trim() === value;
}

function boundedKeyReference(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || KEY_REFERENCE_WHITESPACE_PATTERN.test(value)
    || KEY_REFERENCE_CONTROL_PATTERN.test(value)
    || KEY_REFERENCE_PATH_PATTERN.test(value)) {
    return false;
  }
  if (value.includes('://')) return false;
  const schemeMatch = value.match(KEY_REFERENCE_SCHEME_PATTERN);
  return !schemeMatch || schemeMatch[1].toLowerCase() === 'test-key';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotCanonicalJson(value, code, message) {
  try {
    const bytes = encodeJsonStableV1(value);
    return JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    fail(code, message);
  }
}

module.exports = {
  boundedKeyReference,
  boundedText,
  canonicalInstant,
  deepFreeze,
  hasExactDataKeys,
  snapshotCanonicalJson,
  snapshotDataObject,
};
