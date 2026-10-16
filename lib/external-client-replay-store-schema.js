'use strict';

// #2183: creating and validating the reservations table and its expiry
// index, and the prepared reservation.

const { EXTERNAL_CLIENT_ADMISSION_PERMISSION } = require('./external-client-authority');
const { DUPLICATE_RESULT, EXPECTED_COLUMNS, EXPIRY_INDEX_NAME, RESERVED_RESULT, TABLE_NAME, fail } = require('./external-client-replay-store-contract');

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

module.exports = {
  createAndValidateExpiryIndex,
  createSchema,
  prepareReservation,
  validateTableSchema,
};
