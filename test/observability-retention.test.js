'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function fixture(t) {
  const db = new Database(':memory:');
  let clock = NOW - 40 * DAY;
  const service = createObservabilityService({ db, now: () => clock });
  t.after(() => db.close());
  return { db, service, setNow(value) { clock = value; } };
}

function addOldRun(service, runId, workspaceId) {
  service.recordRunStart({ workspaceId, runId, goal: `old ${runId}` });
  service.recordRunFinish({ workspaceId, runId, status: 'completed' });
}

test('cleanup deletes only old terminal telemetry in the requested workspace and preserves active state', t => {
  const { db, service, setNow } = fixture(t);
  for (const runId of ['run-old-1', 'run-old-2']) addOldRun(service, runId, 'ws-a');
  service.upsertRun({ workspaceId: 'ws-a', runId: 'run-running', status: 'running', startedAt: NOW - 40 * DAY });
  service.upsertRun({ workspaceId: 'ws-a', runId: 'run-paused', status: 'paused', startedAt: NOW - 40 * DAY });
  service.upsertRun({ workspaceId: 'ws-a', runId: 'run-review', status: 'review', startedAt: NOW - 40 * DAY });
  service.recordStep({ workspaceId: 'ws-a', runId: 'run-old-1', status: 'done', tool: 'verify' });
  service.recordStep({ workspaceId: 'ws-a', runId: 'run-running', status: 'done', tool: 'verify' });
  service.recordStep({ workspaceId: 'ws-b', runId: 'run-other', status: 'done', tool: 'verify' });
  service.enqueueJob({ workspaceId: 'ws-a', jobId: 'job-old', goal: 'old queue' });
  service.enqueueJob({ workspaceId: 'ws-a', jobId: 'job-active', goal: 'active queue' });
  db.prepare("UPDATE agent_queue_jobs SET status = 'completed', lease_until = NULL WHERE job_id = 'job-old'").run();
  db.prepare("UPDATE agent_queue_jobs SET status = 'running', lease_until = ? WHERE job_id = 'job-active'").run(NOW - 40 * DAY);
  db.prepare(`INSERT INTO observability_alerts
    (alert_id, rule_id, workspace_id, metric, value, threshold, status, event_id, fired_at, resolved_at)
    VALUES ('alert-old', 'rule-old', 'ws-a', 'error_count', 2, 1, 'resolved', '', ?, ?)`)
    .run(NOW - 40 * DAY, NOW - 40 * DAY);
  db.prepare(`INSERT INTO observability_alerts
    (alert_id, rule_id, workspace_id, metric, value, threshold, status, event_id, fired_at, resolved_at)
    VALUES ('alert-active', 'rule-active', 'ws-a', 'error_count', 2, 1, 'firing', '', ?, NULL)`)
    .run(NOW - 40 * DAY);
  addOldRun(service, 'run-other-old', 'ws-b');
  setNow(NOW);

  const first = service.cleanup({ workspaceId: 'ws-a', at: NOW, batchSize: 1 });
  assert.deepEqual(first.deleted, { events: 1, runs: 1, alerts: 1, queue: 1 });
  assert.equal(first.totalDeleted, 4);
  assert.equal(first.batchSize, 1);

  const remaining = service.cleanup({ workspaceId: 'ws-a', at: NOW, batchSize: 1000 });
  assert.equal(remaining.deleted.runs, 1);
  assert.equal(remaining.deleted.queue, 0);
  assert.equal(remaining.deleted.alerts, 0);
  assert.equal(remaining.deleted.events > 0, true);

  const preservedRuns = service.listRuns({ workspaceId: 'ws-a' }).items.map(run => `${run.runId}:${run.status}`).sort();
  assert.deepEqual(preservedRuns, ['run-paused:paused', 'run-review:review', 'run-running:running']);
  assert.equal(service.listEvents({ workspaceId: 'ws-a', runId: 'run-running' }).items.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_queue_jobs WHERE job_id = ?').get('job-active').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observability_alerts WHERE alert_id = ?').get('alert-active').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observability_runs WHERE workspace_id = ?').get('ws-b').count, 1);
});

test('cleanup is bounded, rejects ambiguous scope, and keeps summary/query state consistent', t => {
  const { service, setNow } = fixture(t);
  for (let index = 0; index < 3; index += 1) {
    service.recordStep({ workspaceId: 'ws-a', runId: `run-${index}`, status: 'done', tool: 'verify' });
  }
  setNow(NOW);

  assert.throws(() => service.cleanup({ workspaceId: '' }), error => error.code === 'INVALID_WORKSPACE_ID');
  assert.throws(() => service.cleanup({ workspaceId: ' ws-a' }), error => error.code === 'INVALID_WORKSPACE_ID');
  assert.throws(() => service.cleanup({ workspaceId: 'ws-a', at: -1 }), error => error.code === 'INVALID_RETENTION_TIMESTAMP');

  const first = service.cleanup({ workspaceId: 'ws-a', at: NOW, batchSize: 2 });
  assert.equal(first.deleted.events, 2);
  assert.equal(first.totalDeleted, 2);
  const summary = service.summary({ workspaceId: 'ws-a', windowMs: 60 * DAY });
  assert.equal(summary.totalRuns, 0);
  const second = service.cleanup({ workspaceId: 'ws-a', at: NOW, batchSize: 2 });
  assert.equal(second.deleted.events, 1);
  assert.equal(second.totalDeleted, 1);
  assert.equal(service.listEvents({ workspaceId: 'ws-a' }).items.length, 0);
});
