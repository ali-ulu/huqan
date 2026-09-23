'use strict';

// #2225: Streaming Trust store record validation extracted from
// github-app-streaming-trust-store.js. One job: binding/receipt/writeback
// record shapes -- patterns, predicates, snapshots. No filesystem access.

const { isPlainObject } = require('./is-plain-object');

const STORE_VERSION = 'v5-c8-streaming-trust-store-v1';
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

module.exports = {
  STORE_VERSION,
  DELIVERY_ID_PATTERN,
  HASH_PATTERN,
  ERROR_CODES,
  GitHubAppStreamingStoreError,
  fail,
  exactKeys,
  positiveSafeInteger,
  canonicalInstant,
  snapshotBinding,
  bindingIdentity,
  snapshotStartedRecord,
  snapshotCompleteRecord,
};
