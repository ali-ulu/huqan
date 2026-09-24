'use strict';

// #2218: trusted key resolution (scope, status, validity window), package
// validation and ed25519 signature verification for the package gate.

const crypto = require('crypto');
const { validateAxiomPackage } = require('./huqan-package-format');
// The gate's only edge to receipt/canonical-receipt.js: the entry file takes
// sha256Hex from here.
const { stableStringify, sha256Hex } = require('./receipt/canonical-receipt');
const { EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS, TRUSTED_KEY_STATUSES, cleanString, fail } = require('./external-client-package-gate-inputs');

function resolveTrustedKey(trustedKeys, keyId, scope, opts = {}) {
  if (
    !trustedKeys
    || typeof trustedKeys !== 'object'
    || Array.isArray(trustedKeys)
    || !Object.prototype.hasOwnProperty.call(trustedKeys, keyId)
  ) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_REQUIRED,
      'signature key is not trusted',
      { keyId },
    );
  }

  const entry = trustedKeys[keyId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.publicKey) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_REQUIRED,
      'trusted key entry must include publicKey and bounded scope',
      { keyId },
    );
  }

  const status = cleanString(entry.status).toLowerCase() || 'active';
  if (!TRUSTED_KEY_STATUSES.includes(status)) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_STATUS_INVALID,
      'trusted key status must be active, revoked or expired',
      { keyId, status },
    );
  }
  const expiresAt = cleanString(entry.expiresAt);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : null;
  if (expiresAt && !Number.isFinite(expiresAtMs)) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_STATUS_INVALID,
      'trusted key expiresAt must be a parseable timestamp',
      { keyId },
    );
  }
  const now = opts.now === undefined ? Date.now() : Number(opts.now);
  if (!Number.isFinite(now)) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_STATUS_INVALID,
      'trusted key status evaluation time must be finite',
      { keyId },
    );
  }
  if (status === 'revoked') {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_REVOKED,
      'trusted signing key is revoked',
      { keyId },
    );
  }
  if (status === 'expired' || (expiresAtMs !== null && expiresAtMs <= now)) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_EXPIRED,
      'trusted signing key is expired',
      { keyId, expiresAt: expiresAt || null },
    );
  }

  const trustedWorkspaceId = cleanString(entry.workspaceId);
  const packageIds = Array.isArray(entry.packageIds)
    ? entry.packageIds.map(cleanString).filter(Boolean)
    : [];
  const identitySubjects = Array.isArray(entry.identitySubjects)
    ? entry.identitySubjects.map(cleanString).filter(Boolean)
    : [];
  const identityKinds = Array.isArray(entry.identityKinds)
    ? entry.identityKinds.map(cleanString).filter(Boolean)
    : [];

  const scopeMatches = trustedWorkspaceId === scope.workspaceId
    && packageIds.includes(scope.packageId)
    && identitySubjects.includes(scope.identitySubject)
    && identityKinds.includes(scope.identityKind);

  if (!scopeMatches) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.TRUSTED_KEY_SCOPE_MISMATCH,
      'trusted key scope does not authorize this identity, workspace and package',
      {
        keyId,
        identitySubject: scope.identitySubject,
        identityKind: scope.identityKind,
        workspaceId: scope.workspaceId,
        packageId: scope.packageId,
      },
    );
  }

  return Object.freeze({
    publicKey: entry.publicKey,
    status,
    expiresAt: expiresAt || null,
  });
}

function assertValidPackage(pkg) {
  const validation = validateAxiomPackage(pkg, { allowExtensions: false });
  if (!validation.ok || validation.warnings.length > 0) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.INVALID_PACKAGE,
      'external client package is invalid',
      {
        errors: validation.errors.map((entry) => ({
          code: entry.code,
          field: entry.field,
          message: entry.message,
        })),
        warnings: validation.warnings.map((entry) => ({
          field: entry.field,
          message: entry.message,
        })),
      },
    );
  }
  return validation;
}

function verifyPackageSignature(pkg, signature, publicKey) {
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature.value, 'base64');
  } catch (_) {
    signatureBytes = Buffer.alloc(0);
  }

  if (signatureBytes.length === 0) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_INVALID,
      'external client package signature is invalid',
      { keyId: signature.keyId },
    );
  }

  const canonicalPackage = stableStringify(pkg);
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(canonicalPackage, 'utf8'),
      publicKey,
      signatureBytes,
    );
  } catch (_) {
    verified = false;
  }

  if (!verified) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_INVALID,
      'external client package signature is invalid',
      { keyId: signature.keyId },
    );
  }

  return canonicalPackage;
}

module.exports = {
  sha256Hex,
  assertValidPackage,
  resolveTrustedKey,
  verifyPackageSignature,
};
