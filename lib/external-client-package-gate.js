'use strict';

// The external client package gate: admits a signed package only for a
// trusted, in-scope key. Inputs live in external-client-package-gate-inputs.js,
// key and signature checks in external-client-package-gate-verify.js (#2218).

const { normalizeWorkspaceId } = require('./workspace-id');
const { EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS, EXTERNAL_CLIENT_PACKAGE_GATE_VERSION, SUPPORTED_SIGNATURE_ALGORITHM, TRUSTED_KEY_STATUSES, cleanString, fail, normalizeIdentity, normalizeSignature } = require('./external-client-package-gate-inputs');
const { assertValidPackage, resolveTrustedKey, sha256Hex, verifyPackageSignature } = require('./external-client-package-gate-verify');

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
