'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  EXTERNAL_CLIENT_AUTHORITY_VERSION,
  EXTERNAL_CLIENT_ADMISSION_PERMISSION,
  EXTERNAL_CLIENT_AUTHORITY_ERRORS,
} = require('./external-client-authority');
const {
  resolveBusyRetryConfig,
  runWithBusyRetry,
} = require('./memory-store-utils');

let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  Database = null;
}

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

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      replay_key TEXT NOT NULL PRIMARY KEY,
      identity_subject TEXT NOT NULL,
      identity_kind TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      package_hash TEXT NOT NULL,
      trusted_key_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK (permission = '${EXTERNAL_CLIENT_ADMISSION_PERMISSION}'),
      created_at TEXT NOT NULL,
      reserved_at INTEGER NOT NULL CHECK (typeof(reserved_at) = 'integer'),
      expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer'),
      CHECK (expires_at > reserved_at)
    ) WITHOUT ROWID
  `);
}

function normalizeSql(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/\s+/g, ' ').trim()
    : '';
}

function validateTableSchema(db) {
  const columns = db.pragma(`table_info(${TABLE_NAME})`);
  if (!Array.isArray(columns) || columns.length !== EXPECTED_COLUMNS.length) {
    fail('external client replay database schema is incompatible');
  }
  for (let index = 0; index < EXPECTED_COLUMNS.length; index += 1) {
    const actual = columns[index];
    const expected = EXPECTED_COLUMNS[index];
    if (!actual
        || actual.cid !== index
        || actual.name !== expected.name
        || String(actual.type || '').toUpperCase() !== expected.type
        || actual.notnull !== expected.notnull
        || actual.pk !== expected.pk
        || actual.dflt_value !== null) {
      fail('external client replay database schema is incompatible', {
        column: expected.name,
      });
    }
  }
  const tableRecord = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(TABLE_NAME);
  const sql = normalizeSql(tableRecord && tableRecord.sql);
  const requiredFragments = [
    'without rowid',
    `check (permission = '${EXTERNAL_CLIENT_ADMISSION_PERMISSION}')`,
    "check (typeof(reserved_at) = 'integer')",
    "check (typeof(expires_at) = 'integer')",
    'check (expires_at > reserved_at)',
  ];
  if (!sql || requiredFragments.some((fragment) => !sql.includes(fragment))) {
    fail('external client replay database schema is incompatible');
  }
}

function createAndValidateExpiryIndex(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ${EXPIRY_INDEX_NAME}
    ON ${TABLE_NAME} (expires_at)
  `);
  const indexes = db.pragma(`index_list(${TABLE_NAME})`);
  const index = Array.isArray(indexes)
    ? indexes.find((entry) => entry && entry.name === EXPIRY_INDEX_NAME)
    : null;
  if (!index || index.unique !== 0 || index.partial !== 0) {
    fail('external client replay expiry index is incompatible');
  }
  const columns = db.pragma(`index_info(${EXPIRY_INDEX_NAME})`);
  if (!Array.isArray(columns)
      || columns.length !== 1
      || columns[0].seqno !== 0
      || columns[0].name !== 'expires_at') {
    fail('external client replay expiry index is incompatible');
  }
}

function isConstraintError(error) {
  const code = error && error.code;
  return code === 'SQLITE_CONSTRAINT'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function initializeDatabase(db, busyRetry) {
  runWithBusyRetry(
    () => {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      db.pragma(`busy_timeout = ${busyRetry.busyTimeoutMs}`);
      createSchema(db);
      validateTableSchema(db);
      createAndValidateExpiryIndex(db);
    },
    { ...busyRetry, label: 'external-client-replay-schema' },
  );
}

function prepareReservation(db) {
  const deleteExpired = db.prepare(
    `DELETE FROM ${TABLE_NAME} WHERE expires_at <= ?`,
  );
  const selectExisting = db.prepare(
    `SELECT expires_at AS expiresAt FROM ${TABLE_NAME} WHERE replay_key = ?`,
  );
  const insertRecord = db.prepare(`
    INSERT INTO ${TABLE_NAME} (
      replay_key,
      identity_subject,
      identity_kind,
      workspace_id,
      package_id,
      package_hash,
      trusted_key_id,
      permission,
      created_at,
      reserved_at,
      expires_at
    ) VALUES (
      @replayKey,
      @identitySubject,
      @identityKind,
      @workspaceId,
      @packageId,
      @packageHash,
      @trustedKeyId,
      @permission,
      @createdAt,
      @reservedAt,
      @expiresAt
    )
  `);

  const transaction = db.transaction((record) => {
    deleteExpired.run(record.reservedAt);
    const existing = selectExisting.get(record.replayKey);
    if (existing) {
      if (!Number.isSafeInteger(existing.expiresAt)
          || existing.expiresAt <= record.reservedAt) {
        fail('external client replay database row is invalid', {
          replayKey: record.replayKey,
        });
      }
      return DUPLICATE_RESULT;
    }

    try {
      insertRecord.run(record);
    } catch (error) {
      if (isConstraintError(error)) {
        const committed = selectExisting.get(record.replayKey);
        if (committed
            && Number.isSafeInteger(committed.expiresAt)
            && committed.expiresAt > record.reservedAt) {
          return DUPLICATE_RESULT;
        }
      }
      throw error;
    }
    return RESERVED_RESULT;
  });

  return transaction.immediate;
}

function createExternalClientReplayStore(options) {
  const snapshot = snapshotOptions(options);
  if (!Database) {
    fail('better-sqlite3 is required for external client durable replay');
  }

  let db;
  let reserveImmediate;
  try {
    db = new Database(snapshot.dbPath);
    initializeDatabase(db, snapshot.busyRetry);
    reserveImmediate = prepareReservation(db);
  } catch (error) {
    try {
      if (db && db.open) db.close();
    } catch (_) {
      // Preserve the original fail-closed initialization result.
    }
    if (isBoundedError(error)) throw error;
    fail('external client replay store initialization failed');
  }

  let closed = false;

  function reserve(record) {
    if (closed) fail('external client replay store is closed');
    const recordSnapshot = snapshotRecord(record);
    return protect(
      'external client replay reservation failed',
      () => runWithBusyRetry(
        () => reserveImmediate(recordSnapshot),
        { ...snapshot.busyRetry, label: 'external-client-replay-reserve' },
      ),
      { replayKey: recordSnapshot.replayKey },
    );
  }

  function close() {
    if (closed) return;
    protect('external client replay store close failed', () => db.close());
    closed = true;
  }

  return Object.freeze({ reserve, close });
}

module.exports = {
  createExternalClientReplayStore,
};
