'use strict';

const crypto = require('node:crypto');
const {
  EXTERNAL_CLIENT_ADMISSION_PERMISSION,
  EXTERNAL_CLIENT_AUTHORITY_ERRORS,
} = require('./external-client-authority');

const EXTERNAL_CLIENT_TRUST_CONFIG_VERSION = 'external-client-trust-config-0-v1';
const EXTERNAL_CLIENT_MAX_TRUSTED_KEYS = 2;
const ROOT_ALLOWED_KEYS = new Set([
  'profileVersion',
  'expectedIdentitySubject',
  'expectedIdentityKind',
  'expectedWorkspaceId',
  'expectedPackageId',
  'permissions',
  'trustedKeys',
]);
const TRUSTED_KEY_ALLOWED_KEYS = new Set([
  'publicKeySpkiDer',
  'workspaceId',
  'packageIds',
  'identitySubjects',
  'identityKinds',
  'notBefore',
  'notAfter',
  'revoked',
]);
const boundedErrors = new WeakSet();

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  boundedErrors.add(error);
  throw error;
}

function protect(code, message, operation, details = {}) {
  try {
    return operation();
  } catch (error) {
    if (error && typeof error === 'object' && boundedErrors.has(error)) throw error;
    fail(code, message, details);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, allowedKeys, code, message) {
  if (!isPlainObject(value)) fail(code, message);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowedKeys.size) fail(code, message);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) fail(code, message);
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
      return publicKey;
    },
    { keyId },
  );
}

function snapshotPermissions(profile) {
  return protect(
    EXTERNAL_CLIENT_AUTHORITY_ERRORS.PERMISSION_REQUIRED,
    'permissions must contain exactly package:admit',
    () => exactSingletonList(
      ownValue(
        profile,
        'permissions',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.PERMISSION_REQUIRED,
        'package admission permission is required',
      ),
      EXTERNAL_CLIENT_ADMISSION_PERMISSION,
      EXTERNAL_CLIENT_AUTHORITY_ERRORS.PERMISSION_REQUIRED,
      'permissions must contain exactly package:admit',
    ),
  );
}

function snapshotTrustedKey(entry, keyId, profileScope) {
  return protect(
    EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
    'trusted key entry is invalid',
    () => {
      exactObject(
        entry,
        TRUSTED_KEY_ALLOWED_KEYS,
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key entry must use the exact bounded shape',
      );
      const workspaceId = exactText(
        entry,
        'workspaceId',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key workspace is required',
      );
      if (workspaceId !== profileScope.workspaceId) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted key workspace must match the profile workspace',
          { keyId },
        );
      }
      const packageIds = exactSingletonList(
        ownValue(
          entry,
          'packageIds',
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted key package scope is required',
        ),
        profileScope.packageId,
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key package scope must exactly match the profile package',
        { keyId, field: 'packageIds' },
      );
      const identitySubjects = exactSingletonList(
        ownValue(
          entry,
          'identitySubjects',
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted key identity subject scope is required',
        ),
        profileScope.identitySubject,
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key identity subject scope must exactly match the profile identity',
        { keyId, field: 'identitySubjects' },
      );
      const identityKinds = exactSingletonList(
        ownValue(
          entry,
          'identityKinds',
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted key identity kind scope is required',
        ),
        profileScope.identityKind,
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key identity kind scope must exactly match the profile identity kind',
        { keyId, field: 'identityKinds' },
      );
      const notBefore = ownValue(
        entry,
        'notBefore',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key notBefore is required',
      );
      const notAfter = ownValue(
        entry,
        'notAfter',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key notAfter is required',
      );
      const notBeforeMs = canonicalInstant(
        notBefore,
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key notBefore is invalid',
        { keyId },
      );
      const notAfterMs = canonicalInstant(
        notAfter,
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key notAfter is invalid',
        { keyId },
      );
      if (notBeforeMs >= notAfterMs) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted key validity interval is reversed',
          { keyId },
        );
      }
      const revoked = ownValue(
        entry,
        'revoked',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key revoked state is required',
      );
      if (revoked === true) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_REVOKED,
          'trusted key is revoked',
          { keyId },
        );
      }
      if (revoked !== false) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted key revoked state must be false',
          { keyId },
        );
      }
      const publicKey = copyPublicKey(
        ownValue(
          entry,
          'publicKeySpkiDer',
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted public key material is required',
        ),
        keyId,
      );
      return Object.freeze({
        publicKey,
        workspaceId,
        packageIds,
        identitySubjects,
        identityKinds,
        notBefore,
        notAfter,
        notBeforeMs,
        notAfterMs,
        revoked: false,
      });
    },
    { keyId },
  );
}

function snapshotTrustedKeys(profile, profileScope) {
  return protect(
    EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
    'trusted key roster is invalid',
    () => {
      const source = ownValue(
        profile,
        'trustedKeys',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
        'trusted key roster is required',
      );
      if (!isPlainObject(source)) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted key roster must be a plain object',
        );
      }
      const rawIds = Reflect.ownKeys(source);
      if (rawIds.length < 1 || rawIds.length > EXTERNAL_CLIENT_MAX_TRUSTED_KEYS) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
          'trusted key roster must contain exactly one or two active keys',
          { keyCount: rawIds.length },
        );
      }
      const records = [];
      const normalizedIds = new Set();
      for (const rawId of rawIds) {
        if (typeof rawId !== 'string') {
          fail(
            EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
            'trusted key IDs must be strings',
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(source, rawId);
        if (!descriptor
            || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || descriptor.enumerable !== true) {
          fail(
            EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
            'trusted key entries must be enumerable own data properties',
            { keyId: rawId },
          );
        }
        const keyId = rawId.trim();
        if (!keyId || normalizedIds.has(keyId)) {
          fail(
            EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID,
            'trusted key IDs collide after normalization',
            { keyId },
          );
        }
        normalizedIds.add(keyId);
        records.push({ keyId, entry: descriptor.value });
      }
      records.sort((left, right) => (left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0));
      const snapshot = Object.create(null);
      for (const { keyId, entry } of records) {
        snapshot[keyId] = snapshotTrustedKey(entry, keyId, profileScope);
      }
      return Object.freeze(snapshot);
    },
  );
}

function materializeExternalClientTrustConfig(profile = {}) {
  return protect(
    EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
    'external client trust profile is invalid',
    () => {
      exactObject(
        profile,
        ROOT_ALLOWED_KEYS,
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
        'external client trust profile must use the exact bounded shape',
      );
      const profileVersion = ownValue(
        profile,
        'profileVersion',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
        'external client trust profile version is required',
      );
      if (profileVersion !== EXTERNAL_CLIENT_TRUST_CONFIG_VERSION) {
        fail(
          EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
          'external client trust profile version is unsupported',
        );
      }
      const expectedIdentitySubject = exactText(
        profile,
        'expectedIdentitySubject',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
        'authoritative identity subject is required',
      );
      const expectedIdentityKind = exactText(
        profile,
        'expectedIdentityKind',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
        'authoritative identity kind is required',
      );
      const expectedWorkspaceId = exactText(
        profile,
        'expectedWorkspaceId',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
        'authoritative workspace is required',
      );
      const expectedPackageId = exactText(
        profile,
        'expectedPackageId',
        EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED,
        'authoritative package is required',
      );
      const permissions = snapshotPermissions(profile);
      const trustedKeys = snapshotTrustedKeys(profile, {
        identitySubject: expectedIdentitySubject,
        identityKind: expectedIdentityKind,
        workspaceId: expectedWorkspaceId,
        packageId: expectedPackageId,
      });
      return Object.freeze({
        profileVersion,
        expectedIdentitySubject,
        expectedIdentityKind,
        expectedWorkspaceId,
        expectedPackageId,
        permissions,
        trustedKeys,
      });
    },
  );
}

module.exports = {
  EXTERNAL_CLIENT_TRUST_CONFIG_VERSION,
  EXTERNAL_CLIENT_MAX_TRUSTED_KEYS,
  materializeExternalClientTrustConfig,
};
