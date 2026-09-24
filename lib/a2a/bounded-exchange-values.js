'use strict';

// #2158: fail-closed value guards for untrusted exchange data -- exact
// shapes, instants, bounded lists, proxy-free frozen snapshots, strict base64.

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');
const { encodeJsonStableV1 } = require('../receipt/cryptographic-profile-contract');
const { INSTANT, MAX_EXCHANGE_BYTES, MAX_LIST_ITEMS, MAX_STRING_BYTES, SIGNATURE_KEYS } = require('./bounded-exchange-contract');

function block(reason) {
  return Object.freeze({ decision: 'block', reason });
}

function plain(value) {
  try {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactObject(value, keys) {
  if (!plain(value)) return false;
  try {
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string')
      || actual.sort().join('\0') !== [...keys].sort().join('\0')) return false;
    return actual.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
        && !descriptor.get && !descriptor.set;
    });
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES && value.trim() === value;
}

function canonicalInstant(value) {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function uniqueStrings(value, { allowEmpty = false, maxItems = MAX_LIST_ITEMS } = {}) {
  return Array.isArray(value)
    && value.length <= maxItems
    && (allowEmpty || value.length > 0)
    && value.every(nonEmpty)
    && new Set(value).size === value.length;
}

function snapshotUntrustedData(value) {
  try {
    if (containsProxy(value)) return null;
    const bytes = encodeJsonStableV1(value);
    if (bytes.length < 1 || bytes.length > MAX_EXCHANGE_BYTES) return null;
    const snapshot = JSON.parse(bytes.toString('utf8'));
    // Canonical JSON produces a detached, data-only structure. This makes a
    // later Proxy/getter mutation unable to alter what the verifier checked.
    return deepFreeze(snapshot);
  } catch {
    return null;
  }
}

function containsProxy(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (utilTypes.isProxy(value) || seen.has(value)) return utilTypes.isProxy(value);
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set
      || containsProxy(descriptor.value, seen)) return true;
  }
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(encodeJsonStableV1(value)).digest('hex');
}

function strictBase64(value, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === expectedBytes && bytes.toString('base64') === value ? bytes : null;
}

function strictBase64url(value, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === expectedBytes && bytes.toString('base64url') === value ? bytes : null;
}

function signatureShape(value) {
  return exactObject(value, SIGNATURE_KEYS)
    && value.algorithm === 'ed25519-v1'
    && nonEmpty(value.keyReference)
    && strictBase64url(value.value, 64) !== null;
}

module.exports = {
  block,
  canonicalHash,
  canonicalInstant,
  containsProxy,
  deepFreeze,
  exactObject,
  nonEmpty,
  plain,
  signatureShape,
  snapshotUntrustedData,
  strictBase64,
  strictBase64url,
  uniqueStrings,
};
