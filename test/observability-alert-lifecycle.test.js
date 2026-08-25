'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applyObservabilitySchema } = require('../lib/observability/schema');
const { createObservabilityService } = require('../lib/observability/service');
const { createObservabilityAuthorizer } = require('../lib/observability/authorization');
const { createObservabilityHttpRouter } = require('../lib/observability/http-router');

function serviceWithClock() {
  const db = new Database(':memory:');
  let clock = 1_700_000_000_000;
  const service = createObservabilityService({ db, now: () => clock });
  return { db, service, advance(ms) { clock += ms; } };
}

test('alerts deduplicate, acknowledge, resolve and refire with a stable fingerprint after cooldown', () => {
  const { db, service, advance } = serviceWithClock();
  const seen = [];
  const unsubscribe = service.subscribe(event => seen.push(event));
  try {
    service.createAlertRule({
      workspaceId: 'ws-a',
      ruleId: 'queue-rule',
      metric: 'queue_depth',
      operator: 'gt',
      threshold: 0,
      cooldownMs: 1_000,
    });
    const firstJob = service.enqueueJob({ workspaceId: 'ws-a', jobId: 'job-1', goal: 'bounded work' });

    let alerts = service.listAlerts({ workspaceId: 'ws-a' });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].status, 'firing');
    assert.match(alerts[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(alerts[0].acknowledgedAt, null);
    assert.equal(alerts[0].resolvedAt, null);

    const acknowledged = service.acknowledgeAlert({ workspaceId: 'ws-a', alertId: alerts[0].alertId });
    assert.equal(acknowledged.status, 'acknowledged');
    assert.ok(acknowledged.acknowledgedAt);
    assert.equal(service.acknowledgeAlert({ workspaceId: 'ws-a', alertId: alerts[0].alertId }), null);

    const claimed = service.claimNextJob({ workerId: 'worker-1' });
    assert.equal(claimed.jobId, firstJob.jobId);
    service.finishJob({
      jobId: firstJob.jobId,
      workspaceId: 'ws-a',
      workerId: 'worker-1',
      status: 'completed',
    });
    alerts = service.listAlerts({ workspaceId: 'ws-a' });
    assert.equal(alerts[0].status, 'resolved');
    assert.ok(alerts[0].acknowledgedAt);
    assert.ok(alerts[0].resolvedAt);

    service.enqueueJob({ workspaceId: 'ws-a', jobId: 'job-2', goal: 'cooldown work' });
    assert.equal(service.listAlerts({ workspaceId: 'ws-a' }).length, 1);
    advance(1_001);
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-2', status: 'done' });

    alerts = service.listAlerts({ workspaceId: 'ws-a' });
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].status, 'firing');
    assert.equal(alerts[0].fingerprint, alerts[1].fingerprint);
    assert.equal(alerts[1].status, 'resolved');

    const alertEvents = service.listEvents({ workspaceId: 'ws-a', limit: 50 }).items
      .filter(item => item.eventType.startsWith('alert_'))
      .map(item => item.eventType)
      .sort();
    assert.deepEqual(alertEvents, [
      'alert_acknowledged',
      'alert_firing',
      'alert_firing',
      'alert_resolved',
    ]);
    assert.equal(seen.filter(event => event.eventType === 'alert_resolved').length, 1);
    assert.equal(seen.filter(event => event.eventType === 'alert_acknowledged').length, 1);
  } finally {
    unsubscribe();
    db.close();
  }
});

test('observability alert schema upgrades an existing alert table idempotently', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE observability_alerts (
      alert_id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      threshold REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'firing',
      event_id TEXT NOT NULL DEFAULT '',
      fired_at INTEGER NOT NULL,
      resolved_at INTEGER
    )`);
    assert.equal(applyObservabilitySchema(db), true);
    assert.equal(applyObservabilitySchema(db), true);
    const columns = db.prepare('PRAGMA table_info(observability_alerts)').all().map(column => column.name);
    assert.equal(columns.includes('fingerprint'), true);
    assert.equal(columns.includes('acknowledged_at'), true);
  } finally {
    db.close();
  }
});

const authorizer = createObservabilityAuthorizer({ policy: JSON.stringify({ memberships: [
  { subject: 'viewer', workspaceId: 'ws-a', role: 'viewer' },
  { subject: 'operator', workspaceId: 'ws-a', role: 'operator' },
  { subject: 'admin', workspaceId: 'ws-a', role: 'admin' },
] }) });

function routerHarness({ subject = 'admin', body = { workspaceId: 'ws-a' } } = {}) {
  const calls = [];
  const writes = [];
  const service = {
    subscribe: () => () => {},
    acknowledgeAlert: input => {
      calls.push({ method: 'acknowledgeAlert', input });
      return {
        alertId: input.alertId,
        workspaceId: input.workspaceId,
        status: 'acknowledged',
      };
    },
  };
  const router = createObservabilityHttpRouter({
    getService: () => service,
    getHealth: () => ({ inspect: () => ({ liveness: { ok: true }, readiness: { ok: true } }) }),
    parseJsonRequest: async () => body,
    writeJson: (_req, _res, status, response) => writes.push({ status, response }),
    denyIfUnauthorized: req => {
      req.huqanAuth = Object.freeze({ subject });
      return true;
    },
    authorizeWorkspace: input => authorizer.authorize(input),
  });
  return { router, calls, writes };
}

test('alert acknowledgement requires exact workspace scope and admin permission before service use', async () => {
  const accepted = routerHarness();
  await accepted.router(
    { method: 'POST', headers: {} },
    {},
    new URL('http://local/api/observability/alerts/alert-1/acknowledge'),
  );
  assert.equal(accepted.writes[0].status, 200);
  assert.equal(accepted.calls[0].input.workspaceId, 'ws-a');
  assert.equal(accepted.calls[0].input.alertId, 'alert-1');

  const viewer = routerHarness({ subject: 'viewer' });
  await viewer.router(
    { method: 'POST', headers: {} },
    {},
    new URL('http://local/api/observability/alerts/alert-1/acknowledge'),
  );
  assert.equal(viewer.writes[0].status, 403);
  assert.equal(viewer.writes[0].response.error.code, 'OBSERVABILITY_PERMISSION_FORBIDDEN');
  assert.deepEqual(viewer.calls, []);

  const crossWorkspace = routerHarness({ subject: 'admin', body: { workspaceId: 'ws-b' } });
  await crossWorkspace.router(
    { method: 'POST', headers: {} },
    {},
    new URL('http://local/api/observability/alerts/alert-1/acknowledge'),
  );
  assert.equal(crossWorkspace.writes[0].status, 403);
  assert.equal(crossWorkspace.writes[0].response.error.code, 'OBSERVABILITY_WORKSPACE_FORBIDDEN');
  assert.deepEqual(crossWorkspace.calls, []);

  const missingScope = routerHarness({ subject: 'admin', body: { alertId: 'alert-1' } });
  await missingScope.router(
    { method: 'POST', headers: {} },
    {},
    new URL('http://local/api/observability/alerts/alert-1/acknowledge'),
  );
  assert.equal(missingScope.writes[0].status, 400);
  assert.equal(missingScope.writes[0].response.error.code, 'MISSING_WORKSPACE_ID');
  assert.deepEqual(missingScope.calls, []);
});

void 0;
