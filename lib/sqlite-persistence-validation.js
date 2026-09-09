'use strict';

const fs = require('fs');

const { assertStoreCreationAllowed } = require('./store-creation-guard');

function hasExistingPersistenceFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch (_) {
    return true;
  }
}

/**
 * Whether `dbPath` already holds a store, refusing first if opening it would
 * bring a store nobody asked for into existence.
 *
 * The refusal lives here, beside the existence check it depends on, so that
 * graph.js reaches it through the import it already has: graph.js is over the
 * line budget in issue #328 and may not grow by even the one line a second
 * require would cost. The decision itself is store-creation-guard's.
 *
 * A path counts as named when the caller chose it, by either option -- only a
 * path derived from the working directory can produce a stray.
 *
 * @param {string} dbPath
 * @param {object} [opts] the graph options the store is being opened with
 * @returns {boolean} whether the database file is already present
 */
function assertStoreOpenAllowed(dbPath, opts = {}) {
  const exists = hasExistingPersistenceFile(dbPath);
  const explicit = Boolean(
    (typeof opts.dbPath === 'string' && opts.dbPath.trim())
    || (typeof opts.memoryPath === 'string' && opts.memoryPath.trim()),
  );
  assertStoreCreationAllowed({ dbPath, explicit, exists });
  return exists;
}

function sqlitePersistenceError(kind, cause) {
  const error = new Error(`SQLite persistence ${kind} failed: ${cause.message}`);
  error.code = kind === 'initialization'
    ? 'SQLITE_PERSISTENCE_INIT_FAILED'
    : 'SQLITE_PERSISTENCE_LOAD_FAILED';
  error.cause = cause;
  return error;
}

function handleSqliteInitializationError(error, hasExistingDatabase, migrationErrorCode) {
  if (error?.code === migrationErrorCode) throw error;
  if (hasExistingDatabase) throw sqlitePersistenceError('initialization', error);
  console.error('[Graph] SQLite başlatılamadı, JSON fallback:', error.message);
}

module.exports = { assertStoreOpenAllowed, handleSqliteInitializationError, hasExistingPersistenceFile, sqlitePersistenceError };
