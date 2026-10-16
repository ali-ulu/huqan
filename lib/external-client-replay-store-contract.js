'use strict';

// #2183: the replay store's table, key sets, results and bounded errors.

// The only edge to the persistence helpers (Adapters): the other replay
// store modules take them from here.
const { resolveBusyRetryConfig, runWithBusyRetry } = require('./memory-store-utils');

const { EXTERNAL_CLIENT_AUTHORITY_ERRORS } = require('./external-client-authority');

const TABLE_NAME = 'external_client_replay_reservations';
const EXPIRY_INDEX_NAME = 'external_client_replay_reservations_expires_at';
const RECORD_KEYS = Object.freeze([
  'replayKey',
  'identitySubject',
  'identityKind',
  'workspaceId',
  'packageId',
  'packageHash',
  'trustedKeyId',
  'permission',
  'createdAt',
  'reservedAt',
  'expiresAt',
]);
const OPTION_KEYS = Object.freeze(['dbPath', 'busyRetry']);
const BUSY_RETRY_KEYS = Object.freeze([
  'busyTimeoutMs',
  'maxAttempts',
  'initialBackoffMs',
  'backoffMultiplier',
  'maxBackoffMs',
]);
const EXPECTED_COLUMNS = Object.freeze([
  Object.freeze({ name: 'replay_key', type: 'TEXT', notnull: 1, pk: 1 }),
  Object.freeze({ name: 'identity_subject', type: 'TEXT', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'identity_kind', type: 'TEXT', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'workspace_id', type: 'TEXT', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'package_id', type: 'TEXT', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'package_hash', type: 'TEXT', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'trusted_key_id', type: 'TEXT', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'permission', type: 'TEXT', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'reserved_at', type: 'INTEGER', notnull: 1, pk: 0 }),
  Object.freeze({ name: 'expires_at', type: 'INTEGER', notnull: 1, pk: 0 }),
]);
const RESERVED_RESULT = Object.freeze({ reserved: true });
const DUPLICATE_RESULT = Object.freeze({ reserved: false });
const BOUNDED_ERROR = Symbol('external-client-replay-store-bounded-error');

function fail(message, details = {}) {
  const error = new Error(message);
  error.code = EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_RESERVATION_FAILED;
  error.details = Object.freeze({ ...details });
  Object.defineProperty(error, BOUNDED_ERROR, { value: true });
  throw error;
}

function isBoundedError(error) {
  try {
    if (!error || typeof error !== 'object') return false;
    const descriptor = Object.getOwnPropertyDescriptor(error, BOUNDED_ERROR);
    return Boolean(descriptor && descriptor.value === true);
  } catch (_) {
    return false;
  }
}

function protect(message, operation, details = {}) {
  try {
    return operation();
  } catch (error) {
    if (isBoundedError(error)) throw error;
    fail(message, details);
  }
}

module.exports = {
  resolveBusyRetryConfig,
  runWithBusyRetry,
  BUSY_RETRY_KEYS,
  DUPLICATE_RESULT,
  EXPECTED_COLUMNS,
  EXPIRY_INDEX_NAME,
  OPTION_KEYS,
  RECORD_KEYS,
  RESERVED_RESULT,
  TABLE_NAME,
  fail,
  isBoundedError,
  protect,
};
