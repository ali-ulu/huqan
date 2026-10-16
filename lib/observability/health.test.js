'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityHealth } = require('./health');
const { createObservabilityService } = require('./service');

test('health reports database, schema, worker, queue lag and last event write without payloads', () => {
  const db = new Database(':memory:');
  let clock = 1_700_000_000_000;
  const service = createObservabilityService({ db, now: () => clock });
  service.recordStep({ workspaceId: 'ws', runId: 'run-1', tool: 'verify', payload: { goal: 'private goal' } });
  service.enqueueJob({ workspaceId: 'ws', goal: 'private queue input' });
  clock += 250;
  const health = createObservabilityHealth({
    getDb: () => db,
    getWorkerState: () => ({ enabled: true, running: true, busy: false }),
    now: () => clock,
  }).inspect('ws');
  assert.equal(health.liveness.ok, true);
  assert.equal(health.readiness.ok, true);
  assert.equal(health.database.ok, true);
  assert.equal(health.schema.ok, true);
  assert.deepEqual(health.schema.missingTables, []);
  assert.deepEqual(health.queue, { depth: 1, lagMs: 250 });
  assert.equal(health.lastEventWriteAt, '2023-11-14T22:13:20.000Z');
  assert.equal(JSON.stringify(health).includes('private'), false);
  db.close();
});

test('disabled optional worker is explicit but does not make synchronous runtime unready', () => {
  const db = new Database(':memory:');
  createObservabilityService({ db });
  const report = createObservabilityHealth({
    getDb: () => db,
    getWorkerState: () => ({ enabled: false, running: false }),
  }).inspect('ws');
  assert.equal(report.worker.enabled, false);
  assert.equal(report.worker.running, false);
  assert.equal(report.readiness.ok, true);
  db.close();
});

test('enabled worker that failed to start makes readiness fail without killing liveness', () => {
  const db = new Database(':memory:');
  createObservabilityService({ db });
  const report = createObservabilityHealth({
    getDb: () => db,
    getWorkerState: () => ({ enabled: true, running: false }),
  }).inspect('ws');
  assert.equal(report.liveness.ok, true);
  assert.equal(report.readiness.ok, false);
  db.close();
});

test('database and schema failures are bounded and secret-free', () => {
  const unavailable = createObservabilityHealth({
    getDb: () => { throw new Error('password=do-not-leak'); },
    getWorkerState: () => ({ enabled: false, running: false }),
  }).inspect('ws');
  assert.equal(unavailable.liveness.ok, true);
  assert.equal(unavailable.readiness.ok, false);
  assert.deepEqual(unavailable.error, { code: 'OBSERVABILITY_DATABASE_UNAVAILABLE' });
  assert.equal(JSON.stringify(unavailable).includes('do-not-leak'), false);

  const db = new Database(':memory:');
  const mismatch = createObservabilityHealth({
    getDb: () => db,
    getWorkerState: () => ({ enabled: false, running: false }),
  }).inspect('ws');
  assert.equal(mismatch.database.ok, true);
  assert.equal(mismatch.schema.ok, false);
  assert.equal(mismatch.readiness.ok, false);
  assert.equal(mismatch.schema.missingTables.length, 5);
  db.close();
});
