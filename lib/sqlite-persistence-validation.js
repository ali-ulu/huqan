'use strict';

const fs = require('fs');

function hasExistingPersistenceFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch (_) {
    return true;
  }
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

module.exports = { handleSqliteInitializationError, hasExistingPersistenceFile, sqlitePersistenceError };
