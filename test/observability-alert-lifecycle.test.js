'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');

function harness() {
  const db = new Database(':memory:');
  let clock = 1_700_000_000_000;
  const service = createObservabilityService({ db, now: () => clock });
  return {
    db,
    service,
    advance(ms) { clock += ms; },
  };
}

test('alert lifecycle fingerprints and deduplicates active alerts', () => {
  const { db, service } = harness();
  try {
    service.createAlertRule({
      workspaceId: 'workspace-a', ruleId: 'success-rule', metric: 'success_rate', operator: 'lt',
      threshold: 0.8, windowMs: 60_000, cooldownMs: 5_000,
    });
    service.recordRunFinish({ workspaceId: 'workspace-a', runId: 'completed-1', status: 'completed' });
    service.recordRunFinish({ workspaceId: 'workspace-a', runId: 'failed-1', status: 'failed', errorSteps: 1 });

    const first = service.listAlerts({ workspaceId: 'workspace-a' })[0];
    assert.equal(first.status, 'firing');
    assert.equal(first.fingerprint.length, 64);
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/);

    service.recordRunFinish({ workspaceId: 'workspace-a', runId: 'failed-2', status: 'failed', errorSteps: 1 });
    const alerts = service.listAlerts({ workspaceId: 'workspace-a' });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].fingerprint, first.fingerprint);
    assert.equal(service.listEvents({ workspaceId: 'workspace-a', eventType: 'alert_firing' }).items.length, 1);
  } finally {
    db.close();
  }
});

test('alert acknowledgement and resolution are workspace-scoped and observable', () => {
  const { db, service, advance } = harness();
  try {
    service.createAlertRule({
      workspaceId: 'workspace-a', ruleId: 'queue-rule', metric: 'queue_depth', operator: 'gt',
      threshold: 0, windowMs: 60_000, cooldownMs: 5_000,
    });
    service.enqueueJob({ workspaceId: 'workspace-a', jobId: 'job-1', goal: 'safe fixture' });
    const alert = service.listAlerts({ workspaceId: 'workspace-a' })[0];

    assert.equal(service.acknowledgeAlert({ workspaceId: 'workspace-b', alertId: alert.alertId }), null);
    assert.equal(service.listAlerts({ workspaceId: 'workspace-a' })[0].status, 'firing');
    const acknowledged = service.acknowledgeAlert({
      workspaceId: 'workspace-a', alertId: alert.alertId, reason: 'operator-reviewed',
    });
    assert.equal(acknowledged.status, 'acknowledged');
    assert.equal(acknowledged.resolvedAt, null);
    assert.equal(service.acknowledgeAlert({ workspaceId: 'workspace-a', alertId: alert.alertId }), null);

    advance(1_000);
    const resolved = service.resolveAlert({
      workspaceId: 'workspace-a', alertId: alert.alertId, reason: 'operator-resolved',
    });
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolvedAt);
    assert.equal(service.resolveAlert({ workspaceId: 'workspace-a', alertId: alert.alertId }), null);
    assert.equal(service.listEvents({ workspaceId: 'workspace-a', eventType: 'alert_acknowledged' }).items.length, 1);
    assert.equal(service.listEvents({ workspaceId: 'workspace-a', eventType: 'alert_resolved' }).items.length, 1);
  } finally {
    db.close();
  }
});

test('threshold recovery resolves an acknowledged alert without creating a duplicate', () => {
  const { db, service } = harness();
  try {
    service.createAlertRule({
      workspaceId: 'workspace-a', ruleId: 'recovery-rule', metric: 'success_rate', operator: 'lt',
      threshold: 0.8, windowMs: 60_000, cooldownMs: 5_000,
    });
    service.recordRunFinish({ workspaceId: 'workspace-a', runId: 'completed-1', status: 'completed' });
    service.recordRunFinish({ workspaceId: 'workspace-a', runId: 'failed-1', status: 'failed', errorSteps: 1 });
    const alert = service.listAlerts({ workspaceId: 'workspace-a' })[0];
    service.acknowledgeAlert({ workspaceId: 'workspace-a', alertId: alert.alertId });

    for (let index = 0; index < 8; index += 1) {
      service.recordRunFinish({ workspaceId: 'workspace-a', runId: `completed-recovery-${index}`, status: 'completed' });
    }

    const resolved = service.listAlerts({ workspaceId: 'workspace-a' })[0];
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.fingerprint, alert.fingerprint);
    assert.equal(service.listEvents({ workspaceId: 'workspace-a', eventType: 'alert_firing' }).items.length, 1);
    assert.equal(service.listEvents({ workspaceId: 'workspace-a', eventType: 'alert_resolved' }).items.length, 1);
  } finally {
    db.close();
  }
});
