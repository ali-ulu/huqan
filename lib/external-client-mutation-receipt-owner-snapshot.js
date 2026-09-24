'use strict';

// #2149: frozen snapshots of the package, the authority context and the one
// candidate claim the authority selected.

const { validateAxiomPackage } = require('./huqan-package-format');
const { AUTHORITY_VERSION, CONTEXT_KEYS, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS, HASH_PATTERN, PACKAGE_KEYS, REPLAY_KEY_PATTERN } = require('./external-client-mutation-receipt-owner-contract');
const { assertAllowedKeys, assertExactKeys, fail, isPlainObject, snapshotJson, text } = require('./external-client-mutation-receipt-owner-json');

function snapshotPackage(input) {
  const pkg = snapshotJson(
    input,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
    'external client package must be bounded deterministic JSON',
  );
  assertExactKeys(
    pkg,
    PACKAGE_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
    'external client package top-level shape is invalid',
  );
  const validation = validateAxiomPackage(pkg, { allowExtensions: false });
  if (!validation.ok || validation.warnings.length > 0) {
    fail(
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
      'external client package validation failed',
      { errors: validation.errors.length, warnings: validation.warnings.length },
    );
  }
  return pkg;
}

function snapshotContext(input) {
  const context = snapshotJson(
    input,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'external client authority context must be bounded deterministic JSON',
  );
  assertExactKeys(
    context,
    CONTEXT_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'external client authority context shape is invalid',
  );
  assertAllowedKeys(
    context.identity,
    ['subject', 'kind'],
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'verified identity is invalid',
  );
  const subject = text(
    context.identity.subject,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'verified identity subject is required',
  );
  const kind = text(
    context.identity.kind,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'verified identity kind is required',
  );
  const workspaceId = text(
    context.workspaceId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'authoritative workspace is required',
  );
  const packageId = text(
    context.packageId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'authoritative package ID is required',
  );
  if (typeof context.packageHash !== 'string' || !HASH_PATTERN.test(context.packageHash)) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'authoritative package hash is invalid');
  }
  if (context.authorityVersion !== AUTHORITY_VERSION || context.permission !== 'package:admit'
    || typeof context.replayKey !== 'string' || !REPLAY_KEY_PATTERN.test(context.replayKey)) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'authority version, permission or replay key is invalid');
  }
  if (!Number.isFinite(context.authority?.reservedAt) || context.authority.reservedAt < 0) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'trusted reservation time is invalid');
  }
  const authority = context.authority;
  if (!isPlainObject(authority)
    || authority.authorityVersion !== AUTHORITY_VERSION
    || authority.permission !== context.permission
    || authority.workspaceId !== workspaceId
    || authority.packageId !== packageId
    || authority.packageHash !== context.packageHash
    || authority.replayKey !== context.replayKey
    || authority.identity?.subject !== subject
    || authority.identity?.kind !== kind) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'authority result does not match SDK context');
  }
  const trustedKeyId = text(
    authority.trustedKeyId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'trusted key ID is required',
  );
  if (context.signature?.keyId !== trustedKeyId || context.signature?.verified !== true) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'verified signature does not match authority');
  }
  return Object.freeze({
    context,
    subject,
    kind,
    workspaceId,
    packageId,
    packageHash: context.packageHash,
    replayKey: context.replayKey,
    trustedKeyId,
    reservedAt: authority.reservedAt,
  });
}

module.exports = {
  snapshotContext,
  snapshotPackage,
};
