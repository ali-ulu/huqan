'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('./service');

const flush = () => new Promise(resolve => setImmediate(resolve));

test('alerts deduplicate, acknowledge, resolve and refire with a stable fingerprint after cooldown', async () => {
  const db = new Database(':memory:');
  let clock = 1_700_000_000_000;
  const deliveries = [];
  const service = createObservabilityService({ db, now: () => clock,
    notificationAdapter: { deliver: async payload => deliveries.push(payload) } });
  try {
    service.createAlertRule({ workspaceId: 'ws-a', ruleId: 'queue-rule', metric: 'queue_depth', operator: 'gt', threshold: 0, cooldownMs: 1_000 });
    service.enqueueJob({ workspaceId: 'ws-a', jobId: 'job-1', goal: 'bounded work' });
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-1', status: 'done' });
    let alerts = service.listAlerts({ workspaceId: 'ws-a' });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].status, 'firing');
    assert.match(alerts[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(service.acknowledgeAlert({ workspaceId: 'ws-a', alertId: alerts[0].alertId }).status, 'acknowledged');
    assert.equal(service.acknowledgeAlert({ workspaceId: 'ws-a', alertId: alerts[0].alertId }), null);

    const claimed = service.claimNextJob({ workerId: 'worker-1' });
    service.finishJob({ jobId: claimed.jobId, workspaceId: 'ws-a', workerId: 'worker-1', status: 'completed' });
    alerts = service.listAlerts({ workspaceId: 'ws-a' });
    assert.equal(alerts[0].status, 'resolved');
    assert.ok(alerts[0].acknowledgedAt);
    assert.ok(alerts[0].resolvedAt);

    service.enqueueJob({ workspaceId: 'ws-a', jobId: 'job-2', goal: 'cooldown work' });
    assert.equal(service.listAlerts({ workspaceId: 'ws-a' }).length, 1);
    clock += 1_001;
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-2', status: 'done' });
    alerts = service.listAlerts({ workspaceId: 'ws-a' });
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].status, 'firing');
    assert.equal(alerts[0].fingerprint, alerts[1].fingerprint);
    await flush();
    assert.deepEqual(deliveries.map(item => item.status), ['firing', 'acknowledged', 'resolved', 'firing']);
    assert.deepEqual(service.listEvents({ workspaceId: 'ws-a', limit: 50 }).items
      .filter(item => item.eventType.startsWith('alert_')).map(item => item.eventType).sort(),
    ['alert_acknowledged', 'alert_firing', 'alert_firing', 'alert_resolved']);
  } finally { db.close(); }
});

test('notification failure never rolls back telemetry or escapes the service boundary', async () => {
  const db = new Database(':memory:');
  const logs = [];
  const service = createObservabilityService({ db,
    notificationAdapter: { deliver: async () => { throw new Error('secret remote detail'); } },
    logger: { error: (...args) => logs.push(args) } });
  try {
    service.createAlertRule({ workspaceId: 'ws-a', metric: 'queue_depth', operator: 'gt', threshold: 0 });
    assert.doesNotThrow(() => service.enqueueJob({ workspaceId: 'ws-a', goal: 'still persists' }));
    await flush();
    assert.equal(service.listAlerts({ workspaceId: 'ws-a' }).length, 1);
    assert.equal(service.listQueue({ workspaceId: 'ws-a' }).length, 1);
    assert.equal(JSON.stringify(logs).includes('secret remote detail'), false);
    assert.equal(logs[0][1].code, 'OBSERVABILITY_NOTIFICATION_FAILED');
  } finally { db.close(); }
});
