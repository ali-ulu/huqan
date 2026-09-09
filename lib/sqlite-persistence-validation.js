'use strict';

const fs = require('fs');

const { assertStoreCreationAllowed } = require('./store-creation-guard');

/** Whether the operator named a store path in the environment. */
function namedByEnvironment(environment = process.env) {
  return ['HUQAN_DB_PATH', 'AXIOM_DB_PATH', 'HUQAN_MEMORY_PATH', 'AXIOM_MEMORY_PATH']
    .some((name) => typeof environment[name] === 'string' && environment[name].trim());
}

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
 * A path counts as named when the caller chose it -- by either option, or by
 * the environment variable. The variable is checked here rather than left to
 * whichever layer assembled the options, because a store named by the operator
 * is named however the value reached the constructor, and a path that arrives
 * through a route that happens to drop it is still not a path nobody chose.
 * Only a path derived from the working directory can produce a stray.
 *
 * @param {string} dbPath
 * @param {object} [opts] the graph options the store is being opened with
 * @returns {boolean} whether the database file is already present
 */
function assertStoreOpenAllowed(dbPath, opts = {}) {
  const exists = hasExistingPersistenceFile(dbPath);
  const explicit = Boolean(
    (typeof opts.dbPath === 'string' && opts.dbPath.trim())
    || (typeof opts.memoryPath === 'string' && opts.memoryPath.trim())
    || namedByEnvironment(),
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
