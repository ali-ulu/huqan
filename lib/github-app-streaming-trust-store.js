'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashCanonicalReceiptPayload } = require('./receipt/canonical-receipt');

const STORE_VERSION = 'v5-c8-streaming-trust-store-v1';
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RECORD_BYTES = 96 * 1024;

const ERROR_CODES = Object.freeze({
  INVALID_ROOT: 'GITHUB_APP_STREAMING_STORE_INVALID_ROOT',
  INVALID_BINDING: 'GITHUB_APP_STREAMING_STORE_INVALID_BINDING',
  INVALID_RECEIPT: 'GITHUB_APP_STREAMING_STORE_INVALID_RECEIPT',
  DELIVERY_CONFLICT: 'GITHUB_APP_STREAMING_STORE_DELIVERY_CONFLICT',
  WRITEBACK_STATE_UNKNOWN: 'GITHUB_APP_STREAMING_WRITEBACK_STATE_UNKNOWN',
  IO_FAILED: 'GITHUB_APP_STREAMING_STORE_IO_FAILED',
});

class GitHubAppStreamingStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubAppStreamingStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GitHubAppStreamingStoreError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

const BINDING_KEYS = Object.freeze([
  'deliveryId',
  'repositoryId',
  'repositoryFullName',
  'installationId',
  'pullRequestNumber',
  'headSha',
  'c7ReceiptHash',
]);
const STARTED_KEYS = Object.freeze(['schemaVersion', 'binding', 'receiptHash', 'externalId', 'startedAt']);
const COMPLETE_KEYS = Object.freeze([
  'schemaVersion', 'binding', 'receiptHash', 'externalId', 'checkRunId', 'startedAt', 'completedAt',
]);

function snapshotBinding(value) {
  if (!exactKeys(value, BINDING_KEYS)) {
    fail(ERROR_CODES.INVALID_BINDING, 'Streaming Trust binding is invalid');
  }
  if (!DELIVERY_ID_PATTERN.test(value.deliveryId)
      || !positiveSafeInteger(value.repositoryId)
      || typeof value.repositoryFullName !== 'string'
      || value.repositoryFullName.length > 256
      || !/^[^/\s]+\/[^/\s]+$/.test(value.repositoryFullName)
      || !positiveSafeInteger(value.installationId)
      || !positiveSafeInteger(value.pullRequestNumber)
      || typeof value.headSha !== 'string'
      || !SHA_PATTERN.test(value.headSha)
      || typeof value.c7ReceiptHash !== 'string'
      || !HASH_PATTERN.test(value.c7ReceiptHash)) {
    fail(ERROR_CODES.INVALID_BINDING, 'Streaming Trust binding is invalid');
  }
  return Object.freeze({ ...value, deliveryId: value.deliveryId.toLowerCase() });
}

function bindingIdentity(binding) {
  return JSON.stringify(snapshotBinding(binding));
}

function receiptHasValidHash(receipt) {
  if (!isPlainObject(receipt)
      || typeof receipt.receiptHash !== 'string'
      || !HASH_PATTERN.test(receipt.receiptHash)) return false;
  const { receiptHash, ...hashable } = receipt;
  try {
    return hashCanonicalReceiptPayload(hashable) === receiptHash;
  } catch (_) {
    return false;
  }
}

function receiptMatchesBinding(receipt, binding) {
  const metadata = receipt && receipt.metadata;
  return receiptHasValidHash(receipt)
    && receipt.previousReceiptHash === binding.c7ReceiptHash
    && isPlainObject(metadata)
    && metadata.deliveryId === binding.deliveryId
    && metadata.repositoryId === binding.repositoryId
    && metadata.repositoryFullName === binding.repositoryFullName
    && metadata.installationId === binding.installationId
    && metadata.pullRequestNumber === binding.pullRequestNumber
    && metadata.headSha === binding.headSha
    && metadata.c7ReceiptHash === binding.c7ReceiptHash;
}

function snapshotStartedRecord(record) {
  if (!exactKeys(record, STARTED_KEYS)
      || record.schemaVersion !== STORE_VERSION
      || typeof record.receiptHash !== 'string' || !HASH_PATTERN.test(record.receiptHash)
      || typeof record.externalId !== 'string' || record.externalId.length === 0 || record.externalId.length > 512
      || !canonicalInstant(record.startedAt)) {
    fail(ERROR_CODES.WRITEBACK_STATE_UNKNOWN, 'Stored Streaming Trust writeback reservation is invalid');
  }
  return Object.freeze({
    state: 'started',
    schemaVersion: STORE_VERSION,
    binding: snapshotBinding(record.binding),
    receiptHash: record.receiptHash,
    externalId: record.externalId,
    startedAt: record.startedAt,
  });
}

function snapshotCompleteRecord(record) {
  if (!exactKeys(record, COMPLETE_KEYS)
      || record.schemaVersion !== STORE_VERSION
      || typeof record.receiptHash !== 'string' || !HASH_PATTERN.test(record.receiptHash)
      || typeof record.externalId !== 'string' || record.externalId.length === 0 || record.externalId.length > 512
      || !positiveSafeInteger(record.checkRunId)
      || !canonicalInstant(record.startedAt)
      || !canonicalInstant(record.completedAt)) {
    fail(ERROR_CODES.WRITEBACK_STATE_UNKNOWN, 'Stored Streaming Trust writeback result is invalid');
  }
  return Object.freeze({
    state: 'complete',
    schemaVersion: STORE_VERSION,
    binding: snapshotBinding(record.binding),
    receiptHash: record.receiptHash,
    externalId: record.externalId,
    checkRunId: record.checkRunId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  });
}

function assertRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0')) {
    fail(ERROR_CODES.INVALID_ROOT, 'Streaming Trust store path must be absolute');
  }
  const root = path.resolve(rootPath);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(ERROR_CODES.INVALID_ROOT, 'Streaming Trust store root must be a real directory');
    }
  } catch (error) {
    if (error instanceof GitHubAppStreamingStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store root could not be created');
  }
  return root;
}

function ensureDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(ERROR_CODES.INVALID_ROOT, 'Streaming Trust store directory must be a real directory');
    }
  } catch (error) {
    if (error instanceof GitHubAppStreamingStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store directory could not be created');
  }
}

function writeExclusiveJson(filePath, value) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record exceeds its size bound');
  }
  let fd;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* no-op */ }
    }
    if (error && error.code === 'EEXIST') return false;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store write failed');
  }
}

function readJsonFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record could not be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record is invalid');
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isPlainObject(value)) fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record is invalid');
    return value;
  } catch (error) {
    if (error instanceof GitHubAppStreamingStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record could not be read');
  }
}

function createGitHubAppStreamingTrustStore({ rootPath }) {
  const root = path.join(assertRoot(rootPath), 'streaming-trust');
  const evaluationsDir = path.join(root, 'evaluations');
  const startedDir = path.join(root, 'writeback-started');
  const completeDir = path.join(root, 'writeback-complete');
  for (const directory of [root, evaluationsDir, startedDir, completeDir]) ensureDirectory(directory);

  function fileFor(directory, deliveryId) {
    if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
      fail(ERROR_CODES.INVALID_BINDING, 'Streaming Trust delivery ID is invalid');
    }
    return path.join(directory, `${deliveryId.toLowerCase()}.json`);
  }

  function readEvaluation(deliveryId) {
    const record = readJsonFile(fileFor(evaluationsDir, deliveryId));
    if (!record) return null;
    const binding = snapshotBinding(record.binding);
    if (!exactKeys(record, ['schemaVersion', 'binding', 'receipt'])
        || record.schemaVersion !== STORE_VERSION
        || !receiptMatchesBinding(record.receipt, binding)) {
      fail(ERROR_CODES.INVALID_RECEIPT, 'Stored Streaming Trust evaluation is invalid');
    }
    return Object.freeze({ binding, receipt: record.receipt });
  }

  function commitEvaluation(inputBinding, receipt) {
    const binding = snapshotBinding(inputBinding);
    if (!receiptMatchesBinding(receipt, binding)) {
      fail(ERROR_CODES.INVALID_RECEIPT, 'Streaming Trust receipt does not match its binding');
    }
    const filePath = fileFor(evaluationsDir, binding.deliveryId);
    const created = writeExclusiveJson(filePath, { schemaVersion: STORE_VERSION, binding, receipt });
    if (created) return Object.freeze({ duplicate: false, binding, receipt });
    const existing = readEvaluation(binding.deliveryId);
    if (!existing
        || bindingIdentity(existing.binding) !== bindingIdentity(binding)
        || JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) {
      fail(ERROR_CODES.DELIVERY_CONFLICT, 'Streaming Trust delivery already has a different evaluation');
    }
    return Object.freeze({ duplicate: true, binding: existing.binding, receipt: existing.receipt });
  }

  function readWriteback(deliveryId) {
    const complete = readJsonFile(fileFor(completeDir, deliveryId));
    if (complete) return snapshotCompleteRecord(complete);
    const started = readJsonFile(fileFor(startedDir, deliveryId));
    if (started) return snapshotStartedRecord(started);
    return Object.freeze({ state: 'none' });
  }

  function reserveWriteback({ binding: inputBinding, receiptHash, externalId, startedAt }) {
    const binding = snapshotBinding(inputBinding);
    if (!HASH_PATTERN.test(receiptHash)
        || typeof externalId !== 'string' || externalId.length === 0 || externalId.length > 512
        || !canonicalInstant(startedAt)) {
      fail(ERROR_CODES.INVALID_BINDING, 'Streaming Trust writeback reservation is invalid');
    }
    const evaluation = readEvaluation(binding.deliveryId);
    if (!evaluation
        || bindingIdentity(evaluation.binding) !== bindingIdentity(binding)
        || evaluation.receipt.receiptHash !== receiptHash) {
      fail(ERROR_CODES.DELIVERY_CONFLICT, 'Streaming Trust writeback has no matching evaluation');
    }

    const existing = readWriteback(binding.deliveryId);
    if (existing.state === 'complete') return existing;
    if (existing.state === 'started') {
      if (bindingIdentity(existing.binding) !== bindingIdentity(binding)
          || existing.receiptHash !== receiptHash
          || existing.externalId !== externalId) {
        fail(ERROR_CODES.DELIVERY_CONFLICT, 'Streaming Trust writeback reservation conflicts with stored state');
      }
      return existing;
    }

    const record = { schemaVersion: STORE_VERSION, binding, receiptHash, externalId, startedAt };
    const created = writeExclusiveJson(fileFor(startedDir, binding.deliveryId), record);
    if (!created) return reserveWriteback({ binding, receiptHash, externalId, startedAt });
    return Object.freeze({ state: 'reserved', ...record });
  }

  function commitWriteback({ binding: inputBinding, receiptHash, externalId, checkRunId, completedAt }) {
    const binding = snapshotBinding(inputBinding);
    if (!HASH_PATTERN.test(receiptHash)
        || typeof externalId !== 'string' || externalId.length === 0 || externalId.length > 512
        || !positiveSafeInteger(checkRunId)
        || !canonicalInstant(completedAt)) {
      fail(ERROR_CODES.INVALID_BINDING, 'Streaming Trust writeback result is invalid');
    }
    const started = readWriteback(binding.deliveryId);
    if (started.state === 'complete') {
      if (bindingIdentity(started.binding) === bindingIdentity(binding)
          && started.receiptHash === receiptHash
          && started.externalId === externalId
          && started.checkRunId === checkRunId) return started;
      fail(ERROR_CODES.DELIVERY_CONFLICT, 'Streaming Trust writeback result conflicts with stored state');
    }
    if (started.state !== 'started'
        || bindingIdentity(started.binding) !== bindingIdentity(binding)
        || started.receiptHash !== receiptHash
        || started.externalId !== externalId) {
      fail(ERROR_CODES.WRITEBACK_STATE_UNKNOWN, 'Streaming Trust writeback state is unknown');
    }

    const record = {
      schemaVersion: STORE_VERSION,
      binding,
      receiptHash,
      externalId,
      checkRunId,
      startedAt: started.startedAt,
      completedAt,
    };
    const created = writeExclusiveJson(fileFor(completeDir, binding.deliveryId), record);
    if (!created) return commitWriteback({ binding, receiptHash, externalId, checkRunId, completedAt });
    return Object.freeze({ state: 'complete', ...record });
  }

  return Object.freeze({
    commitEvaluation,
    readEvaluation,
    reserveWriteback,
    readWriteback,
    commitWriteback,
  });
}

module.exports = {
  STORE_VERSION,
  ERROR_CODES,
  GitHubAppStreamingStoreError,
  createGitHubAppStreamingTrustStore,
};
