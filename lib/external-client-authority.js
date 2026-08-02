'use strict';

const crypto = require('node:crypto');
const {
  EXTERNAL_CLIENT_PACKAGE_GATE_ERRORS,
  enforceExternalClientPackage,
} = require('./external-client-package-gate');
const { stableStringify, sha256Hex } = require('./receipt/canonical-receipt');

const EXTERNAL_CLIENT_AUTHORITY_VERSION = 'external-client-authority-0-v1';
const EXTERNAL_CLIENT_ADMISSION_PERMISSION = 'package:admit';
const EXTERNAL_CLIENT_MAX_PACKAGE_AGE_MS = 300000;
const EXTERNAL_CLIENT_MAX_FUTURE_SKEW_MS = 30000;
const EXTERNAL_CLIENT_REPLAY_TTL_MS = 600000;
const EXTERNAL_CLIENT_AUTHORITY_ERRORS = Object.freeze({
  AUTHORITY_REQUIRED: 'EXTERNAL_CLIENT_AUTHORITY_REQUIRED',
  IDENTITY_MISMATCH: 'EXTERNAL_CLIENT_AUTHORITY_IDENTITY_MISMATCH',
  PERMISSION_REQUIRED: 'EXTERNAL_CLIENT_AUTHORITY_PERMISSION_REQUIRED',
  KEY_INVALID: 'EXTERNAL_CLIENT_AUTHORITY_KEY_INVALID',
  KEY_REVOKED: 'EXTERNAL_CLIENT_AUTHORITY_KEY_REVOKED',
  CREATED_AT_INVALID: 'EXTERNAL_CLIENT_AUTHORITY_CREATED_AT_INVALID',
  STALE: 'EXTERNAL_CLIENT_AUTHORITY_STALE',
  FUTURE_DATED: 'EXTERNAL_CLIENT_AUTHORITY_FUTURE_DATED',
  CLOCK_INVALID: 'EXTERNAL_CLIENT_AUTHORITY_CLOCK_INVALID',
  REPLAY_OWNER_REQUIRED: 'EXTERNAL_CLIENT_AUTHORITY_REPLAY_OWNER_REQUIRED',
  REPLAY_DETECTED: 'EXTERNAL_CLIENT_AUTHORITY_REPLAY_DETECTED',
  REPLAY_RESERVATION_FAILED: 'EXTERNAL_CLIENT_AUTHORITY_REPLAY_RESERVATION_FAILED',
});
const authoritySnapshots = new WeakSet();
const TRUSTED_KEY_ENTRY_ALLOWED_KEYS = new Set([
  'publicKey', 'workspaceId', 'packageIds', 'identitySubjects', 'identityKinds',
  'notBefore', 'notAfter', 'revoked',
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  throw error;
}
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function own(object, key, code, message) {
  if (!plain(object)) fail(code, message, { field: key });
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail(code, message, { field: key });
  }
  return descriptor.value;
}
function exactText(object, key, code, message) {
  const value = own(object, key, code, message);
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(code, message, { field: key });
  return normalized;
}
function instant(value, code, message, details = {}) {
  if (typeof value !== 'string' || value.trim() !== value) fail(code, message, details);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code, message, details);
  }
  return milliseconds;
}
function publicKey(value, keyId) {
  try {
    if (value instanceof crypto.KeyObject) {
      if (value.type !== 'public') throw new TypeError();
      return value;
    }
    try {
      crypto.createPrivateKey(value);
      throw new TypeError();
    } catch (error) {
      if (error instanceof TypeError && error.message === '') throw error;
    }
    const key = crypto.createPublicKey(value);
    if (key.type !== 'public') throw new TypeError();
    return key;
  } catch (_) {
    fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted public key is invalid', { keyId });
  }
}
function stringList(entry, field, keyId) {
  const value = own(entry, field, EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key scope is invalid');
  if (!Array.isArray(value) || value.length === 0) {
    fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key scope must be non-empty', { keyId, field });
  }
  const allowed = new Set(['length']);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    allowed.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const item = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && typeof descriptor.value === 'string' ? descriptor.value.trim() : '';
    if (!item || result.includes(item)) {
      fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key scope must use unique own strings', { keyId, field, index });
    }
    result.push(item);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' || !allowed.has(key))) {
    fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key scope has unsupported properties', { keyId, field });
  }
  return Object.freeze(result);
}
function snapshotTrustedKeys(options) {
  const source = own(options, 'trustedKeys', EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'trusted key authority is required');
  if (!plain(source)) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'trusted key authority must be a plain object');
  const result = Object.create(null);
  for (const rawId of Reflect.ownKeys(source)) {
    if (typeof rawId !== 'string') fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key IDs must be strings');
    const descriptor = Object.getOwnPropertyDescriptor(source, rawId);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key entries must be own data properties', { keyId: rawId });
    }
    const keyId = rawId.trim();
    if (!keyId || Object.prototype.hasOwnProperty.call(result, keyId)) {
      fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key IDs collide after normalization', { keyId });
    }
    const entry = descriptor.value;
    if (!plain(entry)) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key entry must be a plain object', { keyId });
    if (Reflect.ownKeys(entry).some((key) => typeof key === 'symbol' || !TRUSTED_KEY_ENTRY_ALLOWED_KEYS.has(key))) {
      fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key entry has unsupported properties', { keyId });
    }
    const notBefore = own(entry, 'notBefore', EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key notBefore is required');
    const notAfter = own(entry, 'notAfter', EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key notAfter is required');
    const notBeforeMs = instant(notBefore, EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key notBefore is invalid', { keyId });
    const notAfterMs = instant(notAfter, EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key notAfter is invalid', { keyId });
    if (notBeforeMs >= notAfterMs) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key interval is reversed', { keyId });
    const revoked = own(entry, 'revoked', EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key revoked state is required');
    if (revoked === true) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_REVOKED, 'trusted key is revoked', { keyId });
    if (revoked !== false) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key revoked state must be false', { keyId });
    result[keyId] = Object.freeze({
      publicKey: publicKey(own(entry, 'publicKey', EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted public key is required'), keyId),
      workspaceId: exactText(entry, 'workspaceId', EXTERNAL_CLIENT_AUTHORITY_ERRORS.KEY_INVALID, 'trusted key workspace is required'),
      packageIds: stringList(entry, 'packageIds', keyId),
      identitySubjects: stringList(entry, 'identitySubjects', keyId),
      identityKinds: stringList(entry, 'identityKinds', keyId),
      notBefore, notAfter, notBeforeMs, notAfterMs, revoked: false,
    });
  }
  if (Object.keys(result).length === 0) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.AUTHORITY_REQUIRED, 'at least one trusted key is required');
  return Object.freeze(result);
}
function snapshotPermission(options) {
  const value = own(options, 'permissions', EXTERNAL_CLIENT_AUTHORITY_ERRORS.PERMISSION_REQUIRED, 'package admission permission is required');
  const descriptor = Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, '0') : null;
  const permission = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && typeof descriptor.value === 'string' ? descriptor.value.trim() : '';
  if (value?.length !== 1 || permission !== EXTERNAL_CLIENT_ADMISSION_PERMISSION
      || Reflect.ownKeys(value).some((key) => typeof key === 'symbol' || (key !== '0' && key !== 'length'))) {
    fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.PERMISSION_REQUIRED, 'permissions must contain exactly package:admit');
  }
  return permission;
}
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
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function copyDeterministicJson(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return value;
  }
  if (!value || typeof value !== 'object') throw new TypeError('value is not JSON data');
  if (ancestors.has(value)) throw new TypeError('circular JSON data');

  const isArray = Array.isArray(value);
  if (!isArray && !plain(value)) throw new TypeError('JSON objects must be plain');
  const keys = Reflect.ownKeys(value);
  const result = isArray ? [] : {};
  ancestors.add(value);
  try {
    if (isArray) {
      if (keys.length !== value.length + 1 || keys.some((key) => {
        if (key === 'length') return false;
        if (typeof key !== 'string') return true;
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key;
      })) {
        throw new TypeError('JSON arrays must be dense and unextended');
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
          throw new TypeError('JSON array entries must be enumerable data properties');
        }
        result.push(copyDeterministicJson(descriptor.value, ancestors));
      }
      return result;
    }

    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('JSON object key is not canonically serializable');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
        throw new TypeError('JSON object entries must be enumerable data properties');
      }
      result[key] = copyDeterministicJson(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
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
  return Boolean(descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && descriptor.value === true);
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
  if (duplicate(reservation)) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_DETECTED, 'signed package replay detected', { replayKey: keyValue });
  if (!exactReserved(reservation)) fail(EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_RESERVATION_FAILED, 'atomic replay owner returned malformed result', { replayKey: keyValue });
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
