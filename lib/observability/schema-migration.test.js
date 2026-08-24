'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applyObservabilitySchema, getObservabilitySchemaVersion, OBSERVABILITY_SCHEMA_VERSION } = require('./schema');

test('legacy observability schema migrates transactionally without losing queue rows', () => {
  const db = new Database(':memory:');
  applyObservabilitySchema(db);
  db.prepare(`INSERT INTO agent_queue_jobs
    (job_id, workspace_id, goal, status, available_at, created_at, updated_at)
    VALUES ('legacy-job', 'ws-a', 'safe goal', 'queued', 1, 1, 1)`).run();
  db.exec('DROP TABLE observability_schema_meta; ALTER TABLE agent_queue_jobs DROP COLUMN agent_id;');
  assert.equal(getObservabilitySchemaVersion(db), 0);
  applyObservabilitySchema(db);
  assert.equal(getObservabilitySchemaVersion(db), OBSERVABILITY_SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT workspace_id FROM agent_queue_jobs WHERE job_id = 'legacy-job'").get().workspace_id, 'ws-a');
  assert.ok(db.prepare('PRAGMA table_info(agent_queue_jobs)').all().some(column => column.name === 'agent_id'));
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
});

test('newer observability schema fails closed before mutation', () => {
  const db = new Database(':memory:');
  applyObservabilitySchema(db);
  db.prepare('UPDATE observability_schema_meta SET version = 99 WHERE singleton = 1').run();
  assert.throws(() => applyObservabilitySchema(db), { code: 'OBSERVABILITY_SCHEMA_VERSION_UNSUPPORTED' });
  assert.equal(getObservabilitySchemaVersion(db), 99);
  db.close();
});
