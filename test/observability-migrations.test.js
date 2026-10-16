'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  OBSERVABILITY_SCHEMA_VERSION,
  applyObservabilityMigrations,
  readSchemaVersion,
} = require('../lib/observability/migrations');

function hasTable(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

test('migrates a legacy SQLite database to version 1 without losing rows', () => {
  const db = new Database(':memory:');
  try {
    assert.equal(readSchemaVersion(db), 0);
    const first = applyObservabilityMigrations(db);
    assert.deepEqual(first, { previousVersion: 0, version: OBSERVABILITY_SCHEMA_VERSION, migrated: true });
    assert.equal(readSchemaVersion(db), 1);
    assert.equal(hasTable(db, 'observability_events'), true);

    db.prepare(`INSERT INTO observability_events
      (event_id, workspace_id, event_type, created_at) VALUES (?, ?, ?, ?)`)
      .run('event-1', 'workspace-a', 'run_started', 1_700_000_000_000);
    const second = applyObservabilityMigrations(db);
    assert.deepEqual(second, { previousVersion: 1, version: OBSERVABILITY_SCHEMA_VERSION, migrated: false });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observability_events').get().count, 1);
  } finally {
    db.close();
  }
});

test('keeps SQLite global user_version untouched while using namespaced metadata', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('user_version = 37');
    assert.equal(db.pragma('user_version', { simple: true }), 37);
    applyObservabilityMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), 37);
    assert.equal(readSchemaVersion(db), 1);
  } finally {
    db.close();
  }
});

test('adds the queue agent_id column while upgrading a pre-observability queue table', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE agent_queue_jobs (
      job_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      max_steps INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      available_at INTEGER NOT NULL,
      lease_until INTEGER,
      worker_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO agent_queue_jobs
      (job_id, workspace_id, goal, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('job-1', 'workspace-a', 'redacted fixture', 1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000);

    applyObservabilityMigrations(db);
    const columns = db.prepare('PRAGMA table_info(agent_queue_jobs)').all().map(column => column.name);
    assert.ok(columns.includes('agent_id'));
    assert.equal(db.prepare('SELECT goal FROM agent_queue_jobs WHERE job_id = ?').get('job-1').goal, 'redacted fixture');
  } finally {
    db.close();
  }
});

test('rejects a newer schema version before changing the database', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE observability_schema_meta (
      schema_name TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    )`);
    db.prepare('INSERT INTO observability_schema_meta (schema_name, version) VALUES (?, ?)')
      .run('observability', 99);
    assert.throws(
      () => applyObservabilityMigrations(db),
      error => error.code === 'UNSUPPORTED_OBSERVABILITY_SCHEMA_VERSION',
    );
    assert.equal(readSchemaVersion(db), 99);
    assert.equal(hasTable(db, 'observability_events'), false);
  } finally {
    db.close();
  }
});

test('rolls back additive schema changes when version write fails', () => {
  const db = new Database(':memory:');
  const failingDb = {
    exec(sql) {
      if (String(sql).includes('INSERT INTO observability_schema_meta')) throw new Error('version write failed');
      return db.exec(sql);
    },
    prepare: db.prepare.bind(db),
  };
  try {
    assert.throws(() => applyObservabilityMigrations(failingDb), /version write failed/);
    assert.equal(readSchemaVersion(db), 0);
    assert.equal(hasTable(db, 'observability_events'), false);
  } finally {
    db.close();
  }
});
