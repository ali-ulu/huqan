const { RECEIPT_FAMILY_MIGRATION_ERROR_CODE } = require('./graph-record-utils');
const {
  assertStoreOpenAllowed,
  handleSqliteInitializationError,
} = require('./sqlite-persistence-validation');
const { initGraphSchema, createGraphStmts } = require('./graph-sqlite-schema');
const {
  ensureMutationReceiptFamilySchema: ensureReceiptFamilySchema,
} = require('./graph-mutation-receipt-schema');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

function isSqliteAvailable() {
  return Database !== null;
}

function openSqlite(graph, opts) {
  const dbPath = graph._paths.dbPath;
  const hasExistingDatabase = assertStoreOpenAllowed(dbPath, opts);
  try {
    graph._db = new Database(dbPath);
    graph._initDB(opts);
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

function closeSqlite(graph) {
  if (!graph._db) return;
  try { graph._db.close(); } catch (_) {}
  graph._db = null;
  graph._stmts = null;
}

function reopen(graph, opts = graph._sqliteOptions) {
  graph.closeSqlite();
  if (!graph._wantSqlite || Database === null) return;
  graph._openSqlite(opts || {});
}

function initDb(graph, opts = {}) {
  initGraphSchema(graph._db, opts);
  graph._stmts = createGraphStmts(graph._db);
}

function ensureMutationReceiptFamilySchema(graph) {
  return ensureReceiptFamilySchema(graph._db);
}

module.exports = {
  isSqliteAvailable,
  openSqlite,
  closeSqlite,
  reopen,
  initDb,
  ensureMutationReceiptFamilySchema,
};
