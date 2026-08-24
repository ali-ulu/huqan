'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createBackup, restoreBackup } = require('../backupRestore');
const { createObservabilityService } = require('../lib/observability/service');
const { applyObservabilitySchema, getObservabilitySchemaVersion } = require('../lib/observability/schema');

test('backup and restore preserve observability data, workspace scope and redaction', { timeout: 30_000 }, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-backup-'));
  const backupBaseDir = path.join(rootDir, 'backups');
  const dbPath = path.join(rootDir, 'memory.db');
  const secret = 'secret-value-that-must-not-survive';
  let db = new Database(dbPath);
  let service = createObservabilityService({ db });
  service.recordStep({ workspaceId: 'ws-a', runId: 'run-a', traceId: 'trace-a', tool: 'safe', payload: { apiKey: secret, visible: 'ok' } });
  service.recordStep({ workspaceId: 'ws-b', runId: 'run-b', traceId: 'trace-b', tool: 'safe', payload: { visible: 'other' } });
  service.enqueueJob({ workspaceId: 'ws-a', jobId: 'job-a', goal: 'bounded fixture goal' });
  db.close();

  const backup = createBackup({ rootDir, dbPath, backupBaseDir, backupId: 'observability-seed', keepLast: 5 });
  const backupDbPath = path.join(backup.backupDir, 'memory.db');
  assert.ok(fs.existsSync(backupDbPath));
  assert.deepEqual(backup.manifest.observability, {
    applicable: true, complete: true, version: 2, integrity: 'ok', unsafePayloadRows: 0,
  });
  assert.equal(fs.readFileSync(backupDbPath).includes(Buffer.from(secret)), false);
  const snapshot = new Database(backupDbPath, { readonly: true });
  assert.equal(getObservabilitySchemaVersion(snapshot), 2);
  assert.equal(snapshot.prepare("SELECT COUNT(*) count FROM observability_events WHERE workspace_id = 'ws-a'").get().count, 2);
  snapshot.close();
  if (process.platform !== 'win32') assert.equal(fs.statSync(backupDbPath).mode & 0o077, 0);

  db = new Database(dbPath);
  db.exec('DELETE FROM observability_events; DELETE FROM agent_queue_jobs;');
  db.close();
  const restored = restoreBackup({ rootDir, dbPath, backupBaseDir, backupDir: backup.backupDir, keepLast: 5 });
  assert.equal(restored.ok, true);

  db = new Database(dbPath);
  applyObservabilitySchema(db);
  service = createObservabilityService({ db });
  const eventsA = service.listEvents({ workspaceId: 'ws-a', limit: 20 });
  const eventsB = service.listEvents({ workspaceId: 'ws-b', limit: 20 });
  assert.equal(eventsA.items.some(event => event.runId === 'run-b'), false);
  assert.equal(eventsB.items.some(event => event.runId === 'run-a'), false);
  assert.equal(eventsA.items.some(event => JSON.stringify(event).includes(secret)), false);
  assert.equal(service.listQueue({ workspaceId: 'ws-a', limit: 20 }).some(job => job.jobId === 'job-a'), true);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('backup fails closed when observability payload JSON contains sensitive keys', { timeout: 30_000 }, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-unsafe-backup-'));
  const dbPath = path.join(rootDir, 'memory.db');
  const backupBaseDir = path.join(rootDir, 'backups');
  const db = new Database(dbPath);
  createObservabilityService({ db });
  db.prepare(`INSERT INTO observability_events
    (event_id, workspace_id, event_type, payload_json, created_at)
    VALUES ('unsafe', 'ws-a', 'step_finished', '{"token":"forbidden"}', 1)`).run();
  db.close();
  assert.throws(() => createBackup({ rootDir, dbPath, backupBaseDir, backupId: 'unsafe' }), {
    code: 'OBSERVABILITY_BACKUP_VERIFICATION_FAILED',
  });
  assert.equal(fs.existsSync(path.join(backupBaseDir, 'unsafe')), false);
  fs.rmSync(rootDir, { recursive: true, force: true });
});
