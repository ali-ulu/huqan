'use strict';

const {
  EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS,
  enforceExternalClientPackage,
} = require('./external-client-package-gate');
const { stableStringify, sha256Hex } = require('./receipt/canonical-receipt');
const { copyDeterministicJson } = require('./deterministic-json-copy');
const {
  fail, plain, own, exactText, instant, freeze,
} = require('./external-client-authority-primitives');
const {
  snapshotTrustedKeys, snapshotPermission,
} = require('./external-client-trusted-key-snapshot');
const {
  EXTERNAL_CLIENT_AUTHORITY_VERSION,
  EXTERNAL_CLIENT_ADMISSION_PERMISSION,
  EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS,
  EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS,
  EXTERNAL_CLIENT_REPLAY_TTL_MS,
  EXTERNAL_CLIENT_AUTHORITY_ERRORS,
} = require('./external-client-authority-errors');

const authoritySnapshots = new WeakSet();

function snapshotExternalClientAuthority(options = {}) {
  if (!plain(options)) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'authority options must be a plain object');
  const clock = own(options, 'clock', EXTERNAL_CLIENT_AUTHORITY_ERRORS.CLOCK_INVALID, 'trusted clock is required');
  if (typeof clock !== 'function') fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.CLOCK_INVALID, 'trusted clock must be a function');
  const replayStore = own(options, 'replayStore', EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_OWNER_REQUIRED, 'atomic replay owner is required');
  const reserve = plain(replayStore) && Object.getOwnPropertyDescriptor(replayStore, 'reserve');
  if (!reserve || !Object.prototype.hasOwnProperty.call(reserve, 'value') || typeof reserve.value !== 'function') {
    fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_OWNER_REQUIRED, 'atomic replay owner must expose an own reserve function');
  }
  const snapshot = Object.freeze({
    expectedIdentitySubject: exactText(options, 'expectedIdentitySubject', EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'authoritative identity subject is required'),
    expectedIdentityKind: exactText(options, 'expectedIdentityKind', EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'authoritative identity kind is required'),
    expectedWorkspaceId: exactText(options, 'expectedWorkspaceId', EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'authoritative workspace is required'),
    expectedPackageId: exactText(options, 'expectedPackageId', EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'authoritative package is required'),
    permission: snapshotPermission(options),
    trustedKeys: snapshotTrustedKeys(options),
    clock,
    replayReserve: reserve.value.bind(replayStore),
  });
  authoritySnapshots.add(snapshot);
  return snapshot;
}
function trustedNow(clock) {
  let value;
  try { value = clock(); } catch (_) { fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.CLOCK_INVALID, 'trusted clock failed'); }
  if (!Number.isFinite(value)) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.CLOCK_INVALID, 'trusted clock must return finite epoch milliseconds');
  return value;
}
function snapshotPackage(pkg) {
  try {
    return freeze(copyDeterministicJson(pkg));
  } catch (_) {
    fail(
      EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS.INVALID_PACKAGE,
      'external client package must be deterministic JSON',
      { stage: 'snapshot' },
    );
  }
}
function replayKey(gate, createdAt, permission) {
  const digest = sha256Hex(stableStringify({
    authorityVersion: EXTERNAL_CLIENT_AUTHORITY_VERSION,
    identitySubject: gate.identity.subject,
    identityKind: gate.identity.kind,
    workspaceId: gate.workspaceId,
    packageId: gate.packageId,
    packageHash: gate.packageHash,
    trustedKeyId: gate.signature.keyId,
    createdAt,
    permission,
  }));
  return `${EXTERNAL_CLIENT_AUTHORITY_VERSION}:${digest}`;
}
function exactReserved(value) {
  if (!plain(value) || Reflect.ownKeys(value).length !== 1) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'reserved');
  return Boolean(descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && descriptor.enumerable && descriptor.value === true);
}
function duplicate(value) {
  if (value === false) return true;
  if (!plain(value)) return false;
  const reserved = Object.getOwnPropertyDescriptor(value, 'reserved');
  const existing = Object.getOwnPropertyDescriptor(value, 'existing');
  return Boolean((reserved && Object.prototype.hasOwnProperty.call(reserved, 'value') && reserved.value === false)
    || (existing && Object.prototype.hasOwnProperty.call(existing, 'value') && existing.value));
}
async function enforceExternalClientAuthority(input = {}, authority) {
  if (!authoritySnapshots.has(authority)) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'authority snapshot is required');
  const packageSnapshot = snapshotPackage(input && input.package);
  const gate = enforceExternalClientPackage({
    identity: input && input.identity,
    workspaceId: input && input.workspaceId,
    package: packageSnapshot,
    signature: input && input.signature,
  }, {
    expectedWorkspaceId: authority.expectedWorkspaceId,
    expectedPackageId: authority.expectedPackageId,
    trustedKeys: authority.trustedKeys,
  });
  if (gate.identity.subject !== authority.expectedIdentitySubject || gate.identity.kind !== authority.expectedIdentityKind) {
    fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.IDENTITY_MISMATCH, 'verified identity does not match authority');
  }
  const trustedKeyId = gate.signature.keyId;
  const key = authority.trustedKeys[trustedKeyId];
  if (!key) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'verified key is absent from authority', { keyId: trustedKeyId });
  if (key.revoked !== false) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_REVOKED, 'verified key is revoked', { keyId: trustedKeyId });
  const createdAt = packageSnapshot?.manifest?.createdAt;
  const createdAtMs = instant(createdAt, EXTERNAL_CLIENT_AUTHORITY_ERRORS.CREATED_AT_INVALID, 'signed package createdAt is invalid');
  const now = trustedNow(authority.clock);
  if (createdAtMs < key.notBeforeMs || createdAtMs > key.notAfterMs || now < key.notBeforeMs || now > key.notAfterMs) {
    fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'verified key is outside its validity interval', { keyId: trustedKeyId });
  }
  if (now - createdAtMs > EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.STALE, 'signed package is stale', { createdAt });
  if (createdAtMs - now > EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.FUTURE_DATED, 'signed package is future-dated', { createdAt });
  const reservedAt = now;
  const expiresAt = now + EXTERNAL_CLIENT_REPLAY_TTL_MS;
  const keyValue = replayKey(gate, createdAt, authority.permission);
  const record = freeze({ replayKey: keyValue, identitySubject: gate.identity.subject, identityKind: gate.identity.kind,
    workspaceId: gate.workspaceId, packageId: gate.packageId, packageHash: gate.packageHash, trustedKeyId,
    permission: authority.permission, createdAt, reservedAt, expiresAt });
  let reservation;
  try { reservation = await authority.replayReserve(record); }
  catch (_) { fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_RESERVATION_FAILED, 'atomic replay reservation failed', { replayKey: keyValue }); }
  let replayResult;
  try {
    replayResult = duplicate(reservation) ? 'duplicate' : exactReserved(reservation) ? 'reserved' : 'malformed';
  } catch (_) {
    fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_RESERVATION_FAILED, 'atomic replay owner returned malformed result', { replayKey: keyValue });
  }
  if (replayResult === 'duplicate') fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_DETECTED, 'signed package replay detected', { replayKey: keyValue });
  if (replayResult !== 'reserved') fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_RESERVATION_FAILED, 'atomic replay owner returned malformed result', { replayKey: keyValue });
  const authorityReceipt = freeze({ authorityVersion: EXTERNAL_CLIENT_AUTHORITY_VERSION, decision: 'allow',
    permission: authority.permission, identitySubject: gate.identity.subject, identityKind: gate.identity.kind,
    workspaceId: gate.workspaceId, packageId: gate.packageId, packageHash: gate.packageHash, trustedKeyId,
    createdAt, reservedAt, expiresAt, replayKey: keyValue });
  return freeze({ ok: true, decision: 'allow', authorityVersion: EXTERNAL_CLIENT_AUTHORITY_VERSION,
    permission: authority.permission, identity: gate.identity, workspaceId: gate.workspaceId, packageId: gate.packageId,
    packageHash: gate.packageHash, trustedKeyId, createdAt, reservedAt, expiresAt, replayKey: keyValue, gate, authorityReceipt });
}

module.exports = { EXTERNAL_CLIENT_AUTHORITY_VERSION, EXTERNAL_CLIENT_ADMISSION_PERMISSION,
  EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS, EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS, EXTERNAL_CLIENT_REPLAY_TTL_MS,
  EXTERNAL_CLIENT_AUTHORITY_ERRORS, enforceExternalClientAuthority, snapshotExternalClientAuthority };
