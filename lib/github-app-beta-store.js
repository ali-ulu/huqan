'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 'v5-github-app-beta-store-v1';
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RECORD_BYTES = 64 * 1024;

const ERROR_CODES = Object.freeze({
  INVALID_ROOT: 'GITHUB_APP_STORE_INVALID_ROOT',
  UNSAFE_ROOT: 'GITHUB_APP_STORE_UNSAFE_ROOT',
  INVALID_BINDING: 'GITHUB_APP_STORE_INVALID_BINDING',
  DELIVERY_CONFLICT: 'GITHUB_APP_DELIVERY_CONFLICT',
  DELIVERY_STATE_UNKNOWN: 'GITHUB_APP_DELIVERY_STATE_UNKNOWN',
  INVALID_RECEIPT: 'GITHUB_APP_STORE_INVALID_RECEIPT',
  IO_FAILED: 'GITHUB_APP_STORE_IO_FAILED',
});

class GitHubAppStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubAppStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GitHubAppStoreError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && Reflect.ownKeys(value).length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const BINDING_KEYS = Object.freeze([
  'deliveryId', 'event', 'repositoryId', 'repositoryFullName', 'installationId',
  'pullRequestNumber', 'headSha', 'payloadSha256', 'reservedAt',
]);

function snapshotBinding(value) {
  if (!exactKeys(value, BINDING_KEYS)) {
    fail(ERROR_CODES.INVALID_BINDING, 'GitHub App delivery binding is invalid');
  }
  if (!DELIVERY_ID_PATTERN.test(value.deliveryId)
      || value.event !== 'pull_request'
      || !Number.isSafeInteger(value.repositoryId) || value.repositoryId <= 0
      || typeof value.repositoryFullName !== 'string'
      || !/^[^/\s]+\/[^/\s]+$/.test(value.repositoryFullName)
      || !Number.isSafeInteger(value.installationId) || value.installationId <= 0
      || !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber <= 0
      || typeof value.headSha !== 'string' || !SHA_PATTERN.test(value.headSha)
      || typeof value.payloadSha256 !== 'string' || !HASH_PATTERN.test(value.payloadSha256)
      || !canonicalInstant(value.reservedAt)) {
    fail(ERROR_CODES.INVALID_BINDING, 'GitHub App delivery binding is invalid');
  }
  return Object.freeze({ ...value, deliveryId: value.deliveryId.toLowerCase() });
}

function bindingIdentity(binding) {
  const { reservedAt, ...identity } = binding;
  return JSON.stringify(identity);
}

function assertSafeRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0')) {
    fail(ERROR_CODES.INVALID_ROOT, 'GitHub App store path must be absolute');
  }
  const resolved = path.resolve(rootPath);
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length);
  const parts = relative ? relative.split(path.sep) : [];
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (_) {
      fail(ERROR_CODES.IO_FAILED, 'GitHub App store path could not be inspected');
    }
    if (stat.isSymbolicLink()) {
      fail(ERROR_CODES.UNSAFE_ROOT, 'GitHub App store path must not traverse symbolic links');
    }
  }
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(ERROR_CODES.UNSAFE_ROOT, 'GitHub App store root must be a real directory');
    }
  } catch (error) {
    if (error instanceof GitHubAppStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'GitHub App store root could not be created');
  }
  return resolved;
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (_) {
    // Some platforms do not permit directory fsync. File fsync remains required.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeExclusiveJson(filePath, value) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
    fail(ERROR_CODES.IO_FAILED, 'GitHub App store record exceeds the bounded size');
  }
  let fd;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fsyncDirectory(path.dirname(filePath));
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* no-op */ }
    }
    if (error && error.code === 'EEXIST') return false;
    if (error instanceof GitHubAppStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'GitHub App store write failed');
  }
}

function readJsonFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail(ERROR_CODES.IO_FAILED, 'GitHub App store record could not be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    fail(ERROR_CODES.IO_FAILED, 'GitHub App store record is invalid');
  }
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const value = JSON.parse(text);
    if (!isPlainObject(value)) fail(ERROR_CODES.IO_FAILED, 'GitHub App store record is invalid');
    return value;
  } catch (error) {
    if (error instanceof GitHubAppStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'GitHub App store record could not be read');
  }
}

function createGitHubAppBetaStore({ rootPath }) {
  const root = assertSafeRoot(rootPath);
  const reservationsDir = path.join(root, 'reservations');
  const receiptsDir = path.join(root, 'receipts');
  for (const directory of [reservationsDir, receiptsDir]) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(ERROR_CODES.UNSAFE_ROOT, 'GitHub App store subdirectories must be real directories');
      }
    } catch (error) {
      if (error instanceof GitHubAppStoreError) throw error;
      fail(ERROR_CODES.IO_FAILED, 'GitHub App store subdirectory could not be created');
    }
  }

  function pathsFor(deliveryId) {
    if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
      fail(ERROR_CODES.INVALID_BINDING, 'GitHub App delivery ID is invalid');
    }
    const safeId = deliveryId.toLowerCase();
    return {
      reservation: path.join(reservationsDir, `${safeId}.json`),
      receipt: path.join(receiptsDir, `${safeId}.json`),
    };
  }

  function readReservation(deliveryId) {
    const record = readJsonFile(pathsFor(deliveryId).reservation);
    if (!record || record.schemaVersion !== STORE_VERSION || !record.binding) return record;
    return record;
  }

  function readReceipt(deliveryId) {
    const record = readJsonFile(pathsFor(deliveryId).receipt);
    if (!record) return null;
    if (record.schemaVersion !== STORE_VERSION || !isPlainObject(record.receipt)) {
      fail(ERROR_CODES.IO_FAILED, 'GitHub App stored receipt is invalid');
    }
    return record.receipt;
  }

  function reserveDelivery(input) {
    const binding = snapshotBinding(input);
    const filePaths = pathsFor(binding.deliveryId);
    const existingReservation = readJsonFile(filePaths.reservation);
    if (existingReservation) {
      if (existingReservation.schemaVersion !== STORE_VERSION
          || !isPlainObject(existingReservation.binding)) {
        fail(ERROR_CODES.IO_FAILED, 'GitHub App stored reservation is invalid');
      }
      const existingBinding = snapshotBinding(existingReservation.binding);
      if (bindingIdentity(existingBinding) !== bindingIdentity(binding)) {
        fail(ERROR_CODES.DELIVERY_CONFLICT, 'GitHub App delivery GUID was reused with different immutable content');
      }
      const receipt = readReceipt(binding.deliveryId);
      return Object.freeze(receipt
        ? { state: 'complete', binding: existingBinding, receipt }
        : { state: 'pending', binding: existingBinding, receipt: null });
    }

    const created = writeExclusiveJson(filePaths.reservation, {
      schemaVersion: STORE_VERSION,
      binding,
    });
    if (!created) return reserveDelivery(binding);
    return Object.freeze({ state: 'reserved', binding, receipt: null });
  }

  function commitReceipt(inputBinding, receipt) {
    const binding = snapshotBinding(inputBinding);
    if (!isPlainObject(receipt)
        || receipt.deliveryId !== binding.deliveryId
        || receipt.payloadSha256 !== binding.payloadSha256) {
      fail(ERROR_CODES.INVALID_RECEIPT, 'GitHub App receipt does not match its delivery binding');
    }
    const reservation = readReservation(binding.deliveryId);
    if (!reservation || reservation.schemaVersion !== STORE_VERSION || !reservation.binding) {
      fail(ERROR_CODES.DELIVERY_STATE_UNKNOWN, 'GitHub App delivery has no durable reservation');
    }
    const reservedBinding = snapshotBinding(reservation.binding);
    if (bindingIdentity(reservedBinding) !== bindingIdentity(binding)) {
      fail(ERROR_CODES.DELIVERY_CONFLICT, 'GitHub App receipt binding conflicts with its reservation');
    }

    const filePath = pathsFor(binding.deliveryId).receipt;
    const record = { schemaVersion: STORE_VERSION, receipt };
    const created = writeExclusiveJson(filePath, record);
    if (created) return receipt;
    const existing = readReceipt(binding.deliveryId);
    if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
      fail(ERROR_CODES.DELIVERY_CONFLICT, 'GitHub App delivery already has a different receipt');
    }
    return existing;
  }

  return Object.freeze({ reserveDelivery, commitReceipt, readReceipt });
}

module.exports = {
  STORE_VERSION,
  ERROR_CODES,
  GitHubAppStoreError,
  createGitHubAppBetaStore,
};
