'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('./service');
const { createObservabilityRetention, parseRetentionPolicy } = require('./retention');

const POLICY = JSON.stringify({
  enabled: true, workspaceIds: ['ws-a'], batchSize: 10,
  eventAgeMs: 60_000, runAgeMs: 60_000, alertAgeMs: 60_000, queueAgeMs: 60_000,
});

test('bounded retention is workspace scoped and protects active state', () => {
  let timestamp = 1_000;
  const db = new Database(':memory:');
  const service = createObservabilityService({ db, now: () => timestamp });
  service.recordRunStart({ workspaceId: 'ws-a', runId: 'active-run', traceId: 'active-trace' });
  service.recordStep({ workspaceId: 'ws-a', runId: 'active-run', traceId: 'active-trace', tool: 'safe' });
  service.recordRunStart({ workspaceId: 'ws-a', runId: 'done-run', traceId: 'done-trace' });
  service.recordRunFinish({ workspaceId: 'ws-a', runId: 'done-run', traceId: 'done-trace', status: 'completed' });
  service.recordStep({ workspaceId: 'ws-b', runId: 'other-run', traceId: 'other-trace', tool: 'safe' });
  service.enqueueJob({ workspaceId: 'ws-a', jobId: 'done-job', goal: 'safe fixture' });
  service.enqueueJob({ workspaceId: 'ws-a', jobId: 'active-job', goal: 'safe fixture' });
  db.prepare("UPDATE agent_queue_jobs SET status = 'completed', updated_at = 1000 WHERE job_id = 'done-job'").run();
  db.prepare("UPDATE agent_queue_jobs SET status = 'running', lease_until = 999999, updated_at = 1000 WHERE job_id = 'active-job'").run();
  db.prepare(`INSERT INTO observability_alerts
    (alert_id, rule_id, workspace_id, metric, value, threshold, status, fired_at)
    VALUES ('resolved-alert', 'rule', 'ws-a', 'queue_depth', 1, 1, 'resolved', 1000),
           ('firing-alert', 'rule', 'ws-a', 'queue_depth', 1, 1, 'firing', 1000)`).run();

  timestamp = 121_000;
  const retention = createObservabilityRetention({ db, policy: POLICY, now: () => timestamp });
  const result = retention.cleanup({ workspaceId: 'ws-a' });
  assert.equal(result.ok, true);
  assert.ok(result.totalDeleted > 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM observability_runs WHERE run_id = 'active-run'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM observability_events WHERE run_id = 'active-run'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM observability_runs WHERE run_id = 'done-run'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_queue_jobs WHERE job_id = 'done-job'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_queue_jobs WHERE job_id = 'active-job'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM observability_alerts WHERE alert_id = 'resolved-alert'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM observability_alerts WHERE alert_id = 'firing-alert'").get().count, 1);
  assert.ok(service.listEvents({ workspaceId: 'ws-b' }).items.length > 0);
  assert.equal(service.summary({ workspaceId: 'ws-a' }).totalRuns, 1);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
});

test('retention batch size caps each table and disabled policy is inert', () => {
  let timestamp = 1_000;
  const db = new Database(':memory:');
  const service = createObservabilityService({ db, now: () => timestamp });
  for (let index = 0; index < 3; index += 1) service.recordStep({ workspaceId: 'ws-a', runId: `old-${index}`, traceId: `trace-${index}` });
  timestamp = 121_000;
  const retention = createObservabilityRetention({ db, now: () => timestamp, policy: JSON.stringify({
    enabled: true, workspaceIds: ['ws-a'], batchSize: 1, eventAgeMs: 60_000,
  }) });
  assert.equal(retention.cleanup({ workspaceId: 'ws-a' }).deleted.events, 1);
  assert.equal(service.listEvents({ workspaceId: 'ws-a', limit: 10 }).items.length, 2);
  assert.equal(createObservabilityRetention({ db }).cleanup({ workspaceId: 'ws-a' }).code, 'OBSERVABILITY_RETENTION_DISABLED');
  db.close();
});

test('invalid policy and database failure fail safely', () => {
  for (const policy of ['{', '{"enabled":true}', '{"enabled":true,"workspaceIds":["*"]}',
    '{"enabled":true,"workspaceIds":["ws","ws"]}', '{"enabled":true,"workspaceIds":["ws"],"batchSize":0}']) {
    assert.throws(() => parseRetentionPolicy(policy), { code: 'OBSERVABILITY_RETENTION_POLICY_INVALID' });
  }
  const db = new Database(':memory:');
  createObservabilityService({ db });
  const logs = [];
  const retention = createObservabilityRetention({ db, policy: POLICY, logger: { error: (...args) => logs.push(args) } });
  db.close();
  const result = retention.cleanup({ workspaceId: 'ws-a' });
  assert.equal(result.code, 'OBSERVABILITY_RETENTION_FAILED');
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes('database connection is not open'), false);
});
