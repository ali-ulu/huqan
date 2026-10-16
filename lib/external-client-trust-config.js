'use strict';

// Materializes an external client's trust config from a profile: the key
// list and the frozen result. Guards live in external-client-trust-config-guards.js,
// single-key snapshots in external-client-trust-config-keys.js (#2196).

const { EXTERNAL_CLIENT_AUTHORITY_ERRORS } = require('./external-client-authority');
const { isPlainObject } = require('./is-plain-object');
const { EXTERNAL_CLIENT_MAX_TRUSTED_KEYS, EXTERNAL_CLIENT_TRUST_CONFIG_VERSION, ROOT_ALLOWED_KEYS, exactObject, exactText, fail, ownValue, protect } = require('./external-client-trust-config-guards');
const { snapshotPermissions, snapshotTrustedKey } = require('./external-client-trust-config-keys');

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
