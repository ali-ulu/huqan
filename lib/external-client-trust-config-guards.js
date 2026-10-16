'use strict';

// #2196: trust config limits and allowed keys, the bounded error mechanics
// and the exact-shape readers every trust config snapshot goes through.

const crypto = require('node:crypto');
const { EXTERNAL_CLIENT_AUTHORITY_ERRORS } = require('./external-client-authority');
const { isPlainObject } = require('./is-plain-object');

const EXTERNAL_CLIENT_TRUST_CONFIG_VERSION = 'external-client-trust-config-0-v1';
const EXTERNAL_CLIENT_MAX_TRUSTED_KEYS = 2;
const ROOT_ALLOWED_KEYS = Object.freeze([
  'profileVersion',
  'expectedIdentitySubject',
  'expectedIdentityKind',
  'expectedWorkspaceId',
  'expectedPackageId',
  'permissions',
  'trustedKeys',
]);
const TRUSTED_KEY_ALLOWED_KEYS = Object.freeze([
  'publicKeySpkiDer',
  'workspaceId',
  'packageIds',
  'identitySubjects',
  'identityKinds',
  'notBefore',
  'notAfter',
  'revoked',
]);
const BOUNDED_ERROR = Symbol('external-client-trust-config-bounded-error');

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  Object.defineProperty(error, BOUNDED_ERROR, { value: true });
  throw error;
}

function isBoundedError(error) {
  try {
    if (!error || typeof error !== 'object') return false;
    const descriptor = Object.getOwnPropertyDescriptor(error, BOUNDED_ERROR);
    return Boolean(descriptor && descriptor.value === true);
  } catch (_) {
    return false;
  }
}

function protect(code, message, operation, details = {}) {
  try {
    return operation();
  } catch (error) {
    if (isBoundedError(error)) throw error;
    fail(code, message, details);
  }
}


function exactObject(value, allowedKeys, code, message) {
  if (!isPlainObject(value)) fail(code, message);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowedKeys.length) fail(code, message);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) fail(code, message);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) {
      fail(code, message, { field: key });
    }
  }
  return value;
}

function ownValue(object, key, code, message) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true) {
    fail(code, message, { field: key });
  }
  return descriptor.value;
}

function exactText(object, key, code, message) {
  const value = ownValue(object, key, code, message);
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(code, message, { field: key });
  return normalized;
}

function exactSingletonList(value, expected, code, message, details = {}) {
  if (!Array.isArray(value) || value.length !== 1) fail(code, message, details);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')) {
    fail(code, message, details);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, '0');
  const item = descriptor
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && descriptor.enumerable === true
    && typeof descriptor.value === 'string'
    ? descriptor.value.trim()
    : '';
  if (!item || item !== expected) fail(code, message, details);
  return Object.freeze([item]);
}

function canonicalInstant(value, code, message, details = {}) {
  if (typeof value !== 'string' || value.trim() !== value) fail(code, message, details);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code, message, details);
  }
  return milliseconds;
}

function copyPublicKey(value, keyId) {
  return protect(
    EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
    'trusted public key material is invalid',
    () => {
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted public key material must be DER bytes',
          { keyId },
        );
      }
      if (value.byteLength !== 44) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted public key material must be an exact 44-byte Ed25519 SPKI DER value',
          { keyId },
        );
      }
      const visibleBytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const copiedBytes = Buffer.from(visibleBytes);
      const publicKey = crypto.createPublicKey({
        key: copiedBytes,
        format: 'der',
        type: 'spki',
      });
      if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted public key must be a public Ed25519 key',
          { keyId },
        );
      }
      return Object.freeze(publicKey);
    },
    { keyId },
  );
}

module.exports = {
  EXTERNAL_CLIENT_MAX_TRUSTED_KEYS,
  EXTERNAL_CLIENT_TRUST_CONFIG_VERSION,
  ROOT_ALLOWED_KEYS,
  TRUSTED_KEY_ALLOWED_KEYS,
  canonicalInstant,
  copyPublicKey,
  exactObject,
  exactSingletonList,
  exactText,
  fail,
  ownValue,
  protect,
};
