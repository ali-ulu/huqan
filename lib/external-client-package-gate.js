'use strict';

const crypto = require('crypto');
const { validateAxiomPackage } = require('./huqan-package-format');
const { stableStringify, sha256Hex } = require('./receipt/canonical-receipt');
const { normalizeWorkspaceId } = require('./workspace-id');

const EXTERNAL_CLIENT_PACKAGE_GATE_VERSION = 'tb-a6-v2';
const SUPPORTED_SIGNATURE_ALGORITHM = 'ed25519';
const TRUSTED_KEY_STATUSES = Object.freeze(['active', 'revoked', 'expired']);

const EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS = Object.freeze({
  MISSING_IDENTITY: 'EXTERNAL_CLIENT_IDENTITY_REQUIRED',
  MISSING_WORKSPACE: 'EXTERNAL_CLIENT_WORKSPACE_REQUIRED',
  AUTHORITATIVE_WORKSPACE_REQUIRED: 'EXTERNAL_CLIENT_AUTHORITATIVE_WORKSPACE_REQUIRED',
  WORKSPACE_MISMATCH: 'EXTERNAL_CLIENT_WORKSPACE_MISMATCH',
  INVALID_PACKAGE: 'EXTERNAL_CLIENT_PACKAGE_INVALID',
  EXPECTED_PACKAGE_REQUIRED: 'EXTERNAL_CLIENT_EXPECTED_PACKAGE_REQUIRED',
  PACKAGE_ID_MISMATCH: 'EXTERNAL_CLIENT_PACKAGE_ID_MISMATCH',
  PACKAGE_WORKSPACE_MISMATCH: 'EXTERNAL_CLIENT_PACKAGE_WORKSPACE_MISMATCH',
  PACKAGE_IDENTITY_MISMATCH: 'EXTERNAL_CLIENT_PACKAGE_IDENTITY_MISMATCH',
  SIGNATURE_REQUIRED: 'EXTERNAL_CLIENT_SIGNATURE_REQUIRED',
  SIGNATURE_ALGORITHM_UNSUPPORTED: 'EXTERNAL_CLIENT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  TRUSTED_KEY_REQUIRED: 'EXTERNAL_CLIENT_TRUSTED_KEY_REQUIRED',
  TRUSTED_KEY_STATUS_INVALID: 'EXTERNAL_CLIENT_TRUSTED_KEY_STATUS_INVALID',
  TRUSTED_KEY_REVOKED: 'EXTERNAL_CLIENT_TRUSTED_KEY_REVOKED',
  TRUSTED_KEY_EXPIRED: 'EXTERNAL_CLIENT_TRUSTED_KEY_EXPIRED',
  TRUSTED_KEY_SCOPE_MISMATCH: 'EXTERNAL_CLIENT_TRUSTED_KEY_SCOPE_MISMATCH',
  SIGNATURE_INVALID: 'EXTERNAL_CLIENT_SIGNATURE_INVALID',
});

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = { ...details };
  throw error;
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.MISSING_IDENTITY,
      'external client identity is required',
    );
  }

  const subject = cleanString(identity.subject);
  const kind = cleanString(identity.kind);
  if (!subject || !kind) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.MISSING_IDENTITY,
      'external client identity.subject and identity.kind are required',
    );
  }

  return Object.freeze({ subject, kind });
}

function normalizeSignature(signature) {
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_REQUIRED,
      'external client package signature is required',
    );
  }

  const algorithm = cleanString(signature.algorithm).toLowerCase();
  const keyId = cleanString(signature.keyId);
  const value = cleanString(signature.value);

  if (!algorithm || !keyId || !value) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_REQUIRED,
      'signature.algorithm, signature.keyId and signature.value are required',
    );
  }

  if (algorithm !== SUPPORTED_SIGNATURE_ALGORITHM) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.SIGNATURE_ALGORITHM_UNSUPPORTED,
      `signature algorithm must be ${SUPPORTED_SIGNATURE_ALGORITHM}`,
      { algorithm },
    );
  }

  return Object.freeze({ algorithm, keyId, value });
}

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

function enforceExternalClientPackage(input = {}, options = {}) {
  const identity = normalizeIdentity(input.identity);
  const workspaceId = normalizeWorkspaceId(input.workspaceId, {
    required: true,
    errorCode: EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.MISSING_WORKSPACE,
    errorMessage: 'external client workspaceId is required',
  });
  const expectedWorkspaceId = cleanString(options.expectedWorkspaceId);
  if (!expectedWorkspaceId) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.AUTHORITATIVE_WORKSPACE_REQUIRED,
      'authoritative expectedWorkspaceId is required',
    );
  }
  if (workspaceId !== expectedWorkspaceId) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.WORKSPACE_MISMATCH,
      'external client workspace does not match the authoritative workspace',
      { expectedWorkspaceId, workspaceId },
    );
  }

  const pkg = input.package;
  assertValidPackage(pkg);

  const packageId = cleanString(pkg?.manifest?.packageId);
  const packageWorkspaceId = cleanString(pkg?.manifest?.workspaceId);
  const packageCreatedBy = cleanString(pkg?.manifest?.createdBy);
  const expectedPackageId = cleanString(options.expectedPackageId);
  if (!expectedPackageId) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.EXPECTED_PACKAGE_REQUIRED,
      'authoritative expectedPackageId is required',
    );
  }

  if (packageId !== expectedPackageId) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.PACKAGE_ID_MISMATCH,
      'external client packageId does not match the expected package',
      { expectedPackageId, packageId },
    );
  }

  if (packageWorkspaceId !== workspaceId) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.PACKAGE_WORKSPACE_MISMATCH,
      'external client package workspace does not match the client workspace',
      { packageWorkspaceId, workspaceId },
    );
  }

  if (packageCreatedBy !== identity.subject) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.PACKAGE_IDENTITY_MISMATCH,
      'external client package createdBy does not match the client identity',
      { packageCreatedBy, identitySubject: identity.subject },
    );
  }

  const signature = normalizeSignature(input.signature);
  const trustedKey = resolveTrustedKey(options.trustedKeys, signature.keyId, {
    identitySubject: identity.subject,
    identityKind: identity.kind,
    workspaceId,
    packageId,
  }, { now: options.now });
  const canonicalPackage = verifyPackageSignature(pkg, signature, trustedKey.publicKey);
  const packageHash = sha256Hex(canonicalPackage);

  return Object.freeze({
    ok: true,
    decision: 'allow',
    gateVersion: EXTERNAL_CLIENT_PACKAGE_GATE_VERSION,
    identity,
    workspaceId,
    packageId,
    packageFormat: cleanString(pkg.manifest.format),
    packageFormatVersion: cleanString(pkg.manifest.formatVersion),
    packageProtocolVersion: cleanString(
      pkg.manifest.protocolVersion || pkg.manifest.atpVersion,
    ),
    atpVersion: pkg.manifest.format === 'axiom-package'
      ? cleanString(pkg.manifest.atpVersion)
      : null,
    signature: Object.freeze({
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      verified: true,
      trustedKeyStatus: trustedKey.status,
      trustedKeyExpiresAt: trustedKey.expiresAt,
    }),
    packageHash,
    receipt: Object.freeze({
      gateVersion: EXTERNAL_CLIENT_PACKAGE_GATE_VERSION,
      decision: 'allow',
      identitySubject: identity.subject,
      identityKind: identity.kind,
      workspaceId,
      packageId,
      packageFormat: cleanString(pkg.manifest.format),
      packageFormatVersion: cleanString(pkg.manifest.formatVersion),
      packageProtocolVersion: cleanString(
        pkg.manifest.protocolVersion || pkg.manifest.atpVersion,
      ),
      atpVersion: pkg.manifest.format === 'axiom-package'
        ? cleanString(pkg.manifest.atpVersion)
        : null,
      packageHash,
      signatureAlgorithm: signature.algorithm,
      trustedKeyId: signature.keyId,
      trustedKeyStatus: trustedKey.status,
      trustedKeyExpiresAt: trustedKey.expiresAt,
    }),
  });
}

module.exports = {
  EXTERNAL_CLIENT_PACKAGE_GATE_VERSION,
  EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS,
  SUPPORTED_SIGNATURE_ALGORITHM,
  TRUSTED_KEY_STATUSES,
  enforceExternalClientPackage,
};
