'use strict';

// #2196: snapshots of one trusted key and of a profile's permissions, taken
// from caller input without invoking caller code.

const { EXTERNAL_CLIENT_ADMISSION_PERMISSION, EXTERNAL_CLIENT_AUTHORITY_ERRORS } = require('./external-client-authority');
const { TRUSTED_KEY_ALLOWED_KEYS, canonicalInstant, copyPublicKey, exactObject, exactSingletonList, exactText, fail, ownValue, protect } = require('./external-client-trust-config-guards');

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
        revoked: false,
      });
    },
    { keyId },
  );
}

module.exports = {
  snapshotPermissions,
  snapshotTrustedKey,
};
