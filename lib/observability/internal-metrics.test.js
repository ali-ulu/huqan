'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('./service');

test('internal metrics count writes, subscribers, drops, queue lag and worker health without recursive events', () => {
  const db = new Database(':memory:');
  let clock = 1_700_000_000_000;
  const logs = [];
  const service = createObservabilityService({ db, now: () => clock, logger: { error: (...args) => logs.push(args) } });
  try {
    const unsubscribe = service.subscribe(() => { throw Object.assign(new Error('listener failed'), { code: 'LISTENER_FAILED' }); });
    service.recordRunStart({ workspaceId: 'ws-a', runId: 'run-a', traceId: 'trace-a', runtime: 'test' });
    service.enqueueJob({ workspaceId: 'ws-a', jobId: 'job-a', goal: 'sensitive goal must not enter metrics' });
    clock += 5_000;
    service.recordWorkerHealth({ enabled: true, busy: true, failed: true });
    const snapshot = service.internalMetrics();
    assert.equal(snapshot.counters.eventWrites, 2);
    assert.equal(snapshot.counters.subscriberDrops, 2);
    assert.equal(snapshot.counters.workerTicks, 1);
    assert.equal(snapshot.counters.workerFailures, 1);
    assert.equal(snapshot.gauges.subscribers, 1);
    assert.equal(snapshot.gauges.queueLagMs, 5_000);
    assert.equal(snapshot.gauges.workerBusy, true);
    assert.equal(snapshot.lastEventWriteAt, '2023-11-14T22:13:20.000Z');
    assert.equal(service.listEvents({ workspaceId: 'ws-a' }).items.length, 2);
    assert.doesNotMatch(JSON.stringify(snapshot), /sensitive goal|prompt|credential/i);
    assert.doesNotMatch(JSON.stringify(logs), /sensitive goal/);
    unsubscribe();
    assert.equal(service.internalMetrics().gauges.subscribers, 0);
  } finally { db.close(); }
});

test('internal metrics count event write failures and log only safe correlation fields', () => {
  const db = new Database(':memory:');
  const logs = [];
  const service = createObservabilityService({ db, logger: { error: (...args) => logs.push(args) } });
  db.prepare('DROP TABLE observability_events').run();
  assert.throws(() => service.recordRunStart({ workspaceId: 'ws-a', runId: 'run-a', traceId: 'trace-a', runtime: 'test', payload: { secret: 'never-log-me' } }));
  const snapshot = service.internalMetrics();
  assert.equal(snapshot.counters.eventWriteFailures, 1);
  assert.equal(snapshot.counters.eventWrites, 0);
  assert.match(JSON.stringify(logs), /ws-a.*run-a.*trace-a/);
  assert.doesNotMatch(JSON.stringify(logs), /never-log-me/);
  db.close();
});
