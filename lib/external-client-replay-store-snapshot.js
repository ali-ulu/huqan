'use strict';

// #2183: exact-shape snapshots of the store options and of a replay record.

const { BUSY_RETRY_KEYS, OPTION_KEYS, RECORD_KEYS, fail, isBoundedError, protect, resolveBusyRetryConfig } = require('./external-client-replay-store-contract');
const fs = require('node:fs');
const path = require('node:path');
const { EXTERNAL_CLIENT_AUTHORITY_VERSION, EXTERNAL_CLIENT_ADMISSION_PERMISSION } = require('./external-client-authority');
const { isPlainObject } = require('./is-plain-object');

function exactOwnObject(value, allowedKeys, message, options = {}) {
  if (!isPlainObject(value)) fail(message);
  const keys = Reflect.ownKeys(value);
  const requiredKeys = options.requiredKeys || allowedKeys;
  if (keys.length < requiredKeys.length || keys.length > allowedKeys.length) fail(message);
  for (const requiredKey of requiredKeys) {
    if (!keys.includes(requiredKey)) fail(message, { field: requiredKey });
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) fail(message);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) {
      fail(message, { field: key });
    }
  }
  return value;
}

function ownValue(object, key, message) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true) {
    fail(message, { field: key });
  }
  return descriptor.value;
}

function exactString(object, key, message) {
  const value = ownValue(object, key, message);
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(message, { field: key });
  }
  return value;
}

function canonicalInstant(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail('external client replay timestamp is invalid', { field });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('external client replay timestamp is invalid', { field });
  }
  return value;
}

function exactEpoch(value, field) {
  if (!Number.isSafeInteger(value)) {
    fail('external client replay epoch is invalid', { field });
  }
  return value;
}

function snapshotBusyRetry(value) {
  if (value === undefined) return resolveBusyRetryConfig({});
  return protect('external client replay busy-retry configuration is invalid', () => {
    exactOwnObject(
      value,
      BUSY_RETRY_KEYS,
      'external client replay busy-retry configuration is invalid',
      { requiredKeys: [] },
    );
    const copy = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      copy[key] = ownValue(
        value,
        key,
        'external client replay busy-retry configuration is invalid',
      );
    }
    return resolveBusyRetryConfig(copy);
  });
}

function snapshotOptions(options) {
  return protect('external client replay store options are invalid', () => {
    exactOwnObject(
      options,
      OPTION_KEYS,
      'external client replay store options are invalid',
      { requiredKeys: ['dbPath'] },
    );
    const dbPath = exactString(
      options,
      'dbPath',
      'external client replay database path is required',
    );
    if (!path.isAbsolute(dbPath) || dbPath.includes('\u0000')) {
      fail('external client replay database path must be absolute');
    }
    const parentPath = path.dirname(dbPath);
    let parentStat;
    try {
      parentStat = fs.statSync(parentPath);
    } catch (_) {
      fail('external client replay database parent directory is unavailable');
    }
    if (!parentStat.isDirectory()) {
      fail('external client replay database parent path must be a directory');
    }
    try {
      if (fs.existsSync(dbPath) && fs.statSync(dbPath).isDirectory()) {
        fail('external client replay database path must not be a directory');
      }
    } catch (error) {
      if (isBoundedError(error)) throw error;
      fail('external client replay database path is unavailable');
    }
    const busyRetryDescriptor = Object.getOwnPropertyDescriptor(options, 'busyRetry');
    const busyRetry = busyRetryDescriptor
      ? snapshotBusyRetry(busyRetryDescriptor.value)
      : resolveBusyRetryConfig({});
    return Object.freeze({ dbPath, busyRetry: Object.freeze({ ...busyRetry }) });
  });
}

function snapshotRecord(record) {
  return protect('external client replay record is invalid', () => {
    exactOwnObject(record, RECORD_KEYS, 'external client replay record is invalid');
    const replayKey = exactString(record, 'replayKey', 'external client replay key is invalid');
    const replayPrefix = `${EXTERNAL_CLIENT_AUTHORITY_VERSION}:`;
    if (!replayKey.startsWith(replayPrefix)
        || !/^[0-9a-f]{64}$/.test(replayKey.slice(replayPrefix.length))) {
      fail('external client replay key is invalid', { field: 'replayKey' });
    }
    const identitySubject = exactString(
      record,
      'identitySubject',
      'external client replay identity subject is invalid',
    );
    const identityKind = exactString(
      record,
      'identityKind',
      'external client replay identity kind is invalid',
    );
    const workspaceId = exactString(
      record,
      'workspaceId',
      'external client replay workspace is invalid',
    );
    const packageId = exactString(
      record,
      'packageId',
      'external client replay package is invalid',
    );
    const packageHash = exactString(
      record,
      'packageHash',
      'external client replay package hash is invalid',
    );
    if (!/^[0-9a-f]{64}$/.test(packageHash)) {
      fail('external client replay package hash is invalid', { field: 'packageHash' });
    }
    const trustedKeyId = exactString(
      record,
      'trustedKeyId',
      'external client replay trusted-key ID is invalid',
    );
    const permission = exactString(
      record,
      'permission',
      'external client replay permission is invalid',
    );
    if (permission !== EXTERNAL_CLIENT_ADMISSION_PERMISSION) {
      fail('external client replay permission is invalid', { field: 'permission' });
    }
    const createdAt = canonicalInstant(
      ownValue(record, 'createdAt', 'external client replay createdAt is required'),
      'createdAt',
    );
    const reservedAt = exactEpoch(
      ownValue(record, 'reservedAt', 'external client replay reservedAt is required'),
      'reservedAt',
    );
    const expiresAt = exactEpoch(
      ownValue(record, 'expiresAt', 'external client replay expiresAt is required'),
      'expiresAt',
    );
    if (expiresAt <= reservedAt) {
      fail('external client replay expiry must be after reservation');
    }
    return Object.freeze({
      replayKey,
      identitySubject,
      identityKind,
      workspaceId,
      packageId,
      packageHash,
      trustedKeyId,
      permission,
      createdAt,
      reservedAt,
      expiresAt,
    });
  });
}

module.exports = {
  snapshotOptions,
  snapshotRecord,
};
