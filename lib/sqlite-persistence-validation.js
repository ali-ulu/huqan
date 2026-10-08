'use strict';

const fs = require('fs');
const path = require('path');

const { assertStoreCreationAllowed } = require('./store-creation-guard');
const { RECEIPT_FAMILY_MIGRATION_ERROR_CODE } = require('./graph-record-utils');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

/** The environment variables that can name a durable store path. */
const STORE_PATH_VARIABLES = Object.freeze([
  'HUQAN_DB_PATH', 'AXIOM_DB_PATH', 'HUQAN_MEMORY_PATH', 'AXIOM_MEMORY_PATH',
]);

/**
 * Whether an environment variable names the directory `dbPath` sits in, and so
 * makes a store at `dbPath` a deliberate companion rather than a stray.
 *
 * "Some store was named" and "this store was named" are not the same thing, and
 * the guard read them as one: it flagged a path explicit when *any* of the four
 * variables was set, so a caller that named only the graph with `HUQAN_DB_PATH`
 * also legitimized the working directory's unrelated `memory.db`. The guard's
 * job is to refuse a store the working directory produced when nobody asked for
 * it; naming a directory is asking for that directory, nothing else (#3669).
 *
 * Matching is by directory, because naming any store in a directory names that
 * directory: the graph, the memory store and the agent store co-locate by
 * design, so a companion there is chosen, not derived from cwd. The `.json` to
 * `.db` suffix is reconciled first, since naming the JSON memory file names the
 * SQLite store beside it.
 */
function environmentNamesStoreDirectory(dbPath, environment = process.env) {
  const candidate = path.resolve(dbPath).replace(/\.json$/i, '.db');
  const candidateDir = path.dirname(candidate);
  return STORE_PATH_VARIABLES.some((name) => {
    const value = typeof environment[name] === 'string' ? environment[name].trim() : '';
    if (!value) return false;
    return path.dirname(path.resolve(value).replace(/\.json$/i, '.db')) === candidateDir;
  });
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
    || environmentNamesStoreDirectory(dbPath, opts.environment || process.env),
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

function isSqliteAvailable() {
  return Database !== null;
}

function openGraphSqlite(graph, opts = {}, initDb) {
  const dbPath = graph._paths.dbPath;
  const hasExistingDatabase = assertStoreOpenAllowed(dbPath, opts);
  try {
    graph._db = new Database(dbPath);
    initDb(opts);
  } catch (error) {
    try { graph._db?.close(); } catch (_) {}
    graph._db = null;
    graph._stmts = null;
    handleSqliteInitializationError(
      error,
      hasExistingDatabase,
      RECEIPT_FAMILY_MIGRATION_ERROR_CODE,
    );
  }
}

function closeGraphSqlite(graph) {
  if (!graph._db) return;
  try { graph._db.close(); } catch (_) {}
  graph._db = null;
  graph._stmts = null;
}

function reopenGraphSqlite(graph, opts = graph._sqliteOptions, initDb) {
  closeGraphSqlite(graph);
  if (!graph._wantSqlite || Database === null) return;
  openGraphSqlite(graph, opts || {}, initDb);
}

module.exports = {
  assertStoreOpenAllowed,
  environmentNamesStoreDirectory,
  handleSqliteInitializationError,
  hasExistingPersistenceFile,
  sqlitePersistenceError,
  isSqliteAvailable,
  openGraphSqlite,
  closeGraphSqlite,
  reopenGraphSqlite,
};
