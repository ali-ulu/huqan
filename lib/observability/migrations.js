'use strict';

const { applyObservabilitySchema } = require('./schema');

const OBSERVABILITY_SCHEMA_VERSION = 1;
const OBSERVABILITY_SCHEMA_META_TABLE = 'observability_schema_meta';
const OBSERVABILITY_SCHEMA_KEY = 'observability';

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasMetadataTable(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(OBSERVABILITY_SCHEMA_META_TABLE));
}

function readSchemaVersion(db) {
  if (!hasMetadataTable(db)) return 0;
  const row = db.prepare(`SELECT version FROM ${OBSERVABILITY_SCHEMA_META_TABLE} WHERE schema_name = ?`).get(OBSERVABILITY_SCHEMA_KEY);
  if (!row) return 0;
  const version = Number(row.version);
  if (!Number.isInteger(version) || version < 0) {
    throw migrationError('INVALID_OBSERVABILITY_SCHEMA_VERSION', 'SQLite observability schema version is invalid.');
  }
  return version;
}

function writeSchemaVersion(db, version) {
  if (!Number.isInteger(version) || version < 0) {
    throw migrationError('INVALID_OBSERVABILITY_SCHEMA_VERSION', 'SQLite observability schema version is invalid.');
  }
  db.exec(`INSERT INTO ${OBSERVABILITY_SCHEMA_META_TABLE} (schema_name, version)
    VALUES ('${OBSERVABILITY_SCHEMA_KEY}', ${version})
    ON CONFLICT(schema_name) DO UPDATE SET version = excluded.version`);
}

function applyObservabilityMigrations(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('database handle is required');
  }
  const previousVersion = readSchemaVersion(db);
  if (previousVersion > OBSERVABILITY_SCHEMA_VERSION) {
    throw migrationError(
      'UNSUPPORTED_OBSERVABILITY_SCHEMA_VERSION',
      `SQLite observability schema version ${previousVersion} is newer than supported version ${OBSERVABILITY_SCHEMA_VERSION}.`,
    );
  }

  const migrate = () => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${OBSERVABILITY_SCHEMA_META_TABLE} (
      schema_name TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    )`);
    applyObservabilitySchema(db);
    if (previousVersion < OBSERVABILITY_SCHEMA_VERSION) writeSchemaVersion(db, OBSERVABILITY_SCHEMA_VERSION);
  };

  if (typeof db.transaction === 'function') {
    db.transaction(migrate)();
  } else {
    db.exec('BEGIN IMMEDIATE');
    try {
      migrate();
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* preserve the migration failure */ }
      throw error;
    }
  }

  return {
    previousVersion,
    version: OBSERVABILITY_SCHEMA_VERSION,
    migrated: previousVersion < OBSERVABILITY_SCHEMA_VERSION,
  };
}

module.exports = {
  OBSERVABILITY_SCHEMA_KEY,
  OBSERVABILITY_SCHEMA_META_TABLE,
  OBSERVABILITY_SCHEMA_VERSION,
  applyObservabilityMigrations,
  readSchemaVersion,
};
