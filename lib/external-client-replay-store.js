'use strict';

// The external client replay store: one SQLite table of replay-key
// reservations, reserve-once semantics. initializeDatabase stays here: the
// durability contract reads this file for its synchronous = FULL pragma.
// Contract, input snapshots and the schema live in
// external-client-replay-store-*.js (#2183).

const { fail, isBoundedError, protect, runWithBusyRetry } = require('./external-client-replay-store-contract');
const { createAndValidateExpiryIndex, createSchema, prepareReservation, validateTableSchema } = require('./external-client-replay-store-schema');
const { snapshotOptions, snapshotRecord } = require('./external-client-replay-store-snapshot');

let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  Database = null;
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
