'use strict';

/**
 * Validates and freezes the trusted-key and permission portions of an
 * external-client authority configuration. Split out of
 * lib/external-client-authority.js (#2266): that file owns verifying a
 * signed request against an already-built authority snapshot, this one
 * owns building the trusted-key part of that snapshot from raw operator
 * input. The shared validation primitives (fail/plain/own/exactText/
 * instant) live in lib/external-client-authority-primitives.js and are
 * required by both.
 */

const crypto = require('node:crypto');
const {
  fail, plain, own, exactText, instant,
} = require('./external-client-authority-primitives');
const { EXTERNAL_CLIENT_AUTHORITY_ERRORS: E, EXTERNAL_CLIENT_ADMISSION_PERMISSION } = require('./external-client-authority-errors');

const TRUSTED_KEY_ENTRY_ALLOWED_KEYS = new Set([
  'publicKey', 'workspaceId', 'packageIds', 'identitySubjects', 'identityKinds',
  'notBefore', 'notAfter', 'revoked',
]);

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
    fail(E.KEY_INVALID, 'trusted public key is invalid', { keyId });
  }
}

function stringList(entry, field, keyId) {
  const value = own(entry, field, E.KEY_INVALID, 'trusted key scope is invalid');
  if (!Array.isArray(value) || value.length === 0) {
    fail(E.KEY_INVALID, 'trusted key scope must be non-empty', { keyId, field });
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
      fail(E.KEY_INVALID, 'trusted key scope must use unique own strings', { keyId, field, index });
    }
    result.push(item);
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' || !allowed.has(key))) {
    fail(E.KEY_INVALID, 'trusted key scope has unsupported properties', { keyId, field });
  }
  return Object.freeze(result);
}

function snapshotTrustedKeys(options) {
  const source = own(options, 'trustedKeys', E.AUTHORITY_REQUIRED, 'trusted key authority is required');
  if (!plain(source)) fail(E.AUTHORITY_REQUIRED, 'trusted key authority must be a plain object');
  const result = Object.create(null);
  for (const rawId of Reflect.ownKeys(source)) {
    if (typeof rawId !== 'string') fail(E.KEY_INVALID, 'trusted key IDs must be strings');
    const descriptor = Object.getOwnPropertyDescriptor(source, rawId);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(E.KEY_INVALID, 'trusted key entries must be own data properties', { keyId: rawId });
    }
    const keyId = rawId.trim();
    if (!keyId || Object.prototype.hasOwnProperty.call(result, keyId)) {
      fail(E.KEY_INVALID, 'trusted key IDs collide after normalization', { keyId });
    }
    const entry = descriptor.value;
    if (!plain(entry)) fail(E.KEY_INVALID, 'trusted key entry must be a plain object', { keyId });
    if (Reflect.ownKeys(entry).some((key) => typeof key === 'symbol' || !TRUSTED_KEY_ENTRY_ALLOWED_KEYS.has(key))) {
      fail(E.KEY_INVALID, 'trusted key entry has unsupported properties', { keyId });
    }
    const notBefore = own(entry, 'notBefore', E.KEY_INVALID, 'trusted key notBefore is required');
    const notAfter = own(entry, 'notAfter', E.KEY_INVALID, 'trusted key notAfter is required');
    const notBeforeMs = instant(notBefore, E.KEY_INVALID, 'trusted key notBefore is invalid', { keyId });
    const notAfterMs = instant(notAfter, E.KEY_INVALID, 'trusted key notAfter is invalid', { keyId });
    if (notBeforeMs >= notAfterMs) fail(E.KEY_INVALID, 'trusted key interval is reversed', { keyId });
    const revoked = own(entry, 'revoked', E.KEY_INVALID, 'trusted key revoked state is required');
    if (revoked === true) fail(E.KEY_REVOKED, 'trusted key is revoked', { keyId });
    if (revoked !== false) fail(E.KEY_INVALID, 'trusted key revoked state must be false', { keyId });
    result[keyId] = Object.freeze({
      publicKey: publicKey(own(entry, 'publicKey', E.KEY_INVALID, 'trusted public key is required'), keyId),
      workspaceId: exactText(entry, 'workspaceId', E.KEY_INVALID, 'trusted key workspace is required'),
      packageIds: stringList(entry, 'packageIds', keyId),
      identitySubjects: stringList(entry, 'identitySubjects', keyId),
      identityKinds: stringList(entry, 'identityKinds', keyId),
      notBefore, notAfter, notBeforeMs, notAfterMs, revoked: false,
    });
  }
  if (Object.keys(result).length === 0) fail(E.AUTHORITY_REQUIRED, 'at least one trusted key is required');
  return Object.freeze(result);
}

function snapshotPermission(options) {
  const value = own(options, 'permissions', E.PERMISSION_REQUIRED, 'package admission permission is required');
  const descriptor = Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, '0') : null;
  const permission = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && typeof descriptor.value === 'string' ? descriptor.value.trim() : '';
  if (value?.length !== 1 || permission !== EXTERNAL_CLIENT_ADMISSION_PERMISSION
      || Reflect.ownKeys(value).some((key) => typeof key === 'symbol' || (key !== '0' && key !== 'length'))) {
    fail(E.PERMISSION_REQUIRED, 'permissions must contain exactly package:admit');
  }
  return permission;
}

module.exports = {
  TRUSTED_KEY_ENTRY_ALLOWED_KEYS,
  snapshotTrustedKeys,
  snapshotPermission,
};
