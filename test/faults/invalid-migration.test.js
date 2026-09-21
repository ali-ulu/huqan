'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  OBSERVABILITY_SCHEMA_VERSION,
  applyObservabilityMigrations,
  readSchemaVersion,
} = require('../../lib/observability/migrations');
const { tempDir } = require('./helpers');

function hasTable(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

test('invalid migration rolls back halfway changes and can be retried cleanly', (t) => {
  const root = tempDir(t, 'huqan-fault-migration-');
  const db = new Database(path.join(root, 'memory.db'));
  const failingDb = {
    exec(sql) {
      if (String(sql).includes('INSERT INTO observability_schema_meta')) {
        throw new Error('fault injection: migration failed halfway');
      }
      return db.exec(sql);
    },
    prepare: db.prepare.bind(db),
  };

  try {
    assert.throws(
      () => applyObservabilityMigrations(failingDb),
      /migration failed halfway/,
    );
    assert.equal(readSchemaVersion(db), 0);
    assert.equal(hasTable(db, 'observability_events'), false);

    const recovered = applyObservabilityMigrations(db);
    assert.equal(recovered.version, OBSERVABILITY_SCHEMA_VERSION);
    assert.equal(readSchemaVersion(db), OBSERVABILITY_SCHEMA_VERSION);
    assert.equal(hasTable(db, 'observability_events'), true);
  } finally {
    db.close();
  }
});
