'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('./service');

test('v1 queue, alert and rule pages use stable bounded cursors', () => {
  const db = new Database(':memory:');
  const service = createObservabilityService({ db, now: () => 1_700_000_000_000 });
  try {
    for (const id of ['a', 'b', 'c']) service.enqueueJob({ workspaceId: 'ws-a', jobId: id, goal: `job ${id}` });
    const queue1 = service.pageQueue({ workspaceId: 'ws-a', limit: 2 });
    assert.deepEqual(queue1.items.map(item => item.jobId), ['c', 'b']);
    assert.equal(queue1.hasMore, true);
    assert.deepEqual(service.pageQueue({ workspaceId: 'ws-a', limit: 2, cursor: queue1.nextCursor }).items.map(item => item.jobId), ['a']);

    for (const id of ['a', 'b', 'c']) service.createAlertRule({ workspaceId: 'ws-a', ruleId: id, metric: 'queue_depth', operator: 'gt', threshold: 99 });
    const rules1 = service.pageAlertRules({ workspaceId: 'ws-a', limit: 2 });
    assert.deepEqual(rules1.items.map(item => item.ruleId), ['c', 'b']);
    assert.deepEqual(service.pageAlertRules({ workspaceId: 'ws-a', limit: 2, cursor: rules1.nextCursor }).items.map(item => item.ruleId), ['a']);

    const insert = db.prepare(`INSERT INTO observability_alerts
      (alert_id, rule_id, workspace_id, metric, value, threshold, fingerprint, status, fired_at)
      VALUES (?, 'a', 'ws-a', 'queue_depth', 1, 0, ?, 'resolved', ?)`);
    for (const id of ['a', 'b', 'c']) insert.run(id, `fingerprint-${id}`, 1_700_000_000_000);
    const alerts1 = service.pageAlerts({ workspaceId: 'ws-a', limit: 2 });
    assert.deepEqual(alerts1.items.map(item => item.alertId), ['c', 'b']);
    assert.deepEqual(service.pageAlerts({ workspaceId: 'ws-a', limit: 2, cursor: alerts1.nextCursor }).items.map(item => item.alertId), ['a']);
    assert.throws(() => service.pageQueue({ workspaceId: 'ws-a', cursor: 'not-a-cursor' }), { code: 'INVALID_OBSERVABILITY_CURSOR' });
  } finally { db.close(); }
});
