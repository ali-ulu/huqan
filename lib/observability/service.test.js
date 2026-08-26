'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('./service');

function serviceWithClock() {
  const db = new Database(':memory:');
  let clock = 1_700_000_000_000;
  const service = createObservabilityService({ db, now: () => clock });
  return { db, service, advance(ms) { clock += ms; } };
}

test('observability persists workspace-scoped runs and paginated events', () => {
  const { db, service, advance } = serviceWithClock();
  try {
    service.recordRunStart({ workspaceId: 'ws-a', runId: 'run-a', goal: 'private goal', objective: 'verify', runtime: 'agent-v3' });
    advance(25);
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-a', tool: 'verify', status: 'done', durationMs: 25, result: { data: { tokens: 12 } }, payload: { goal: 'must not be stored' } });
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-a', tool: 'verify', status: 'done', durationMs: 20 });
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-a', tool: 'memorySearch', status: 'done', durationMs: 15 });
    advance(25);
    service.recordRunFinish({ workspaceId: 'ws-a', runId: 'run-a', goal: 'private goal', objective: 'verify', runtime: 'agent-v3', status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_050, stepCount: 3, successfulSteps: 3, usage: { tokens: 12, costMicros: 240 } });
    service.recordStep({ workspaceId: 'ws-b', runId: 'run-b', tool: 'privateTool', status: 'done', durationMs: 10 });
    service.recordRunFinish({ workspaceId: 'ws-b', runId: 'run-b', goal: 'other goal', status: 'blocked', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_010, stepCount: 1, blockedSteps: 1 });

    const runs = service.listRuns({ workspaceId: 'ws-a' });
    assert.equal(runs.items.length, 1);
    assert.equal(runs.items[0].runId, 'run-a');
    assert.equal(runs.items[0].tokens, 12);
    assert.equal(runs.items[0].costMicros, 240);
    assert.deepEqual(runs.items[0].tools, [
      { name: 'verify', count: 2 },
      { name: 'memorySearch', count: 1 },
    ]);
    assert.equal(runs.items[0].toolCallCount, 3);
    assert.equal(runs.items[0].tools.some(tool => tool.name === 'privateTool'), false);

    const events = service.listEvents({ workspaceId: 'ws-a', limit: 2 });
    assert.equal(events.items.length, 2);
    assert.equal(events.items[0].workspaceId, 'ws-a');
    assert.equal(events.items[0].payload.goal, undefined);
    assert.equal(service.listEvents({ workspaceId: 'ws-b' }).items.every(item => item.workspaceId === 'ws-b'), true);
  } finally {
    db.close();
  }
});

test('listEvents applies an optional bounded workspace time window', () => {
  const { db, service, advance } = serviceWithClock();
  try {
    service.recordStep({ workspaceId: 'ws-a', runId: 'old', tool: 'verify', status: 'done' });
    advance(61_000);
    service.recordStep({ workspaceId: 'ws-a', runId: 'recent', tool: 'verify', status: 'done' });
    service.recordStep({ workspaceId: 'ws-b', runId: 'other', tool: 'privateTool', status: 'done' });

    const filtered = service.listEvents({ workspaceId: 'ws-a', windowMs: 60_000 });
    assert.deepEqual(filtered.items.map(event => event.runId), ['recent']);
    assert.equal(filtered.items.every(event => event.workspaceId === 'ws-a'), true);
    assert.deepEqual(service.listEvents({ workspaceId: 'ws-a' }).items.map(event => event.runId), ['recent', 'old']);
  } finally {
    db.close();
  }
});

test('listRuns applies an optional bounded workspace time window', () => {
  const { db, service, advance } = serviceWithClock();
  try {
    service.recordRunFinish({ workspaceId: 'ws-a', runId: 'old', status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_100 });
    advance(61_000);
    service.recordRunFinish({ workspaceId: 'ws-a', runId: 'recent', status: 'failed', startedAt: 1_700_000_061_000, finishedAt: 1_700_000_061_100, errorSteps: 1 });
    service.recordRunFinish({ workspaceId: 'ws-b', runId: 'other', status: 'completed', startedAt: 1_700_000_061_000, finishedAt: 1_700_000_061_100 });

    const filtered = service.listRuns({ workspaceId: 'ws-a', windowMs: 60_000 });
    assert.deepEqual(filtered.items.map(run => run.runId), ['recent']);
    assert.equal(filtered.items.every(run => run.workspaceId === 'ws-a'), true);
    assert.deepEqual(service.listRuns({ workspaceId: 'ws-a' }).items.map(run => run.runId), ['recent', 'old']);
  } finally {
    db.close();
  }
});

test('listRuns returns bounded cursor pages without duplicates', () => {
  const { db, service } = serviceWithClock();
  try {
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      service.recordRunFinish({ workspaceId: 'ws-a', runId, status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_100 });
    }

    const first = service.listRuns({ workspaceId: 'ws-a', limit: 2 });
    assert.deepEqual(first.items.map(run => run.runId), ['run-c', 'run-b']);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);

    const second = service.listRuns({ workspaceId: 'ws-a', limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.items.map(run => run.runId), ['run-a']);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
  } finally {
    db.close();
  }
});

test('observability computes success, latency, token and known cost metrics', () => {
  const { db, service } = serviceWithClock();
  try {
    service.recordRunFinish({ workspaceId: 'ws', runId: 'ok', status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_100, stepCount: 2, successfulSteps: 2, usage: { tokens: 100, costMicros: 500 } });
    service.recordRunFinish({ workspaceId: 'ws', runId: 'bad', status: 'failed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_300, stepCount: 1, errorSteps: 1, usage: { tokens: 40, costMicros: 100 } });
    const metrics = service.summary({ workspaceId: 'ws', windowMs: 60_000 });
    assert.equal(metrics.totalRuns, 2);
    assert.equal(metrics.completedRuns, 1);
    assert.equal(metrics.failedRuns, 1);
    assert.equal(metrics.successRate, 0.5);
    assert.equal(metrics.avgLatencyMs, 200);
    assert.equal(metrics.p95LatencyMs, 300);
    assert.equal(metrics.totalTokens, 140);
    assert.equal(metrics.tokenKnown, true);
    assert.equal(metrics.totalCostMicros, 600);
    assert.equal(metrics.costKnown, true);
  } finally {
    db.close();
  }
});

test('summary aggregates workspace-scoped tool usage', () => {
  const { db, service, advance } = serviceWithClock();
  try {
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-a', tool: 'verify', status: 'done' });
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-a', tool: 'verify', status: 'done' });
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-a', tool: 'memorySearch', status: 'done' });
    service.recordStep({ workspaceId: 'ws-b', runId: 'run-b', tool: 'privateTool', status: 'done' });
    advance(61_000);
    service.recordStep({ workspaceId: 'ws-a', runId: 'run-a', tool: 'verify', status: 'done' });

    const metrics = service.summary({ workspaceId: 'ws-a', windowMs: 60_000 });
    assert.deepEqual(metrics.toolUsage, [{ name: 'verify', count: 1 }]);
    assert.equal(metrics.toolCallCount, 1);
    assert.equal(metrics.toolUsage.some(tool => tool.name === 'privateTool'), false);
  } finally {
    db.close();
  }
});

test('observability fires a cooldown-controlled alert and publishes it', () => {
  const { db, service, advance } = serviceWithClock();
  const seen = [];
  const unsubscribe = service.subscribe(event => seen.push(event));
  try {
    service.createAlertRule({ workspaceId: 'ws', name: 'success', metric: 'success_rate', operator: 'lt', threshold: 0.8, windowMs: 60_000, cooldownMs: 5_000 });
    service.recordRunFinish({ workspaceId: 'ws', runId: 'bad', status: 'failed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_100, errorSteps: 1 });
    assert.equal(service.listAlerts({ workspaceId: 'ws' }).length, 1);
    assert.equal(seen.some(event => event.eventType === 'alert_firing'), true);
    advance(1000);
    service.recordRunFinish({ workspaceId: 'ws', runId: 'bad-2', status: 'failed', startedAt: 1_700_000_001_000, finishedAt: 1_700_000_001_100, errorSteps: 1 });
    assert.equal(service.listAlerts({ workspaceId: 'ws' }).length, 1);
  } finally {
    unsubscribe();
    db.close();
  }
});

test('alert rules are capped per workspace and the cap includes disabled rules', () => {
  const { db, service } = serviceWithClock();
  try {
    for (let index = 0; index < 99; index += 1) {
      service.createAlertRule({
        workspaceId: 'ws',
        ruleId: `rule-${index}`,
        metric: 'error_count',
        operator: 'gt',
        threshold: 999,
      });
    }
    service.createAlertRule({
      workspaceId: 'ws',
      ruleId: 'disabled-rule',
      metric: 'error_count',
      operator: 'gt',
      threshold: 999,
      enabled: false,
    });

    assert.equal(service.listAlertRules({ workspaceId: 'ws', limit: 100 }).length, 100);
    assert.throws(
      () => service.createAlertRule({ workspaceId: 'ws', metric: 'error_count', operator: 'gt', threshold: 999 }),
      error => error.code === 'ALERT_RULE_LIMIT_REACHED',
    );
    assert.doesNotThrow(() => service.createAlertRule({ workspaceId: 'other', metric: 'error_count', operator: 'gt', threshold: 999 }));
    assert.equal(service.listAlertRules({ workspaceId: 'other' }).length, 1);
  } finally {
    db.close();
  }
});

test('alert evaluation shares one summary per distinct window on an event', () => {
  const db = new Database(':memory:');
  let clock = 1_700_000_000_000;
  let summaryQueryCount = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (sql.includes('workspace_id = ?') && (sql.includes('updated_at >= ?') || sql.includes('created_at >= ?'))) {
      summaryQueryCount += 1;
    }
    return prepare(sql);
  };
  const service = createObservabilityService({ db, now: () => clock });
  try {
    for (let index = 0; index < 3; index += 1) {
      service.createAlertRule({ workspaceId: 'ws', metric: 'error_count', operator: 'gt', threshold: 999, windowMs: 60_000 });
    }
    service.createAlertRule({ workspaceId: 'ws', metric: 'error_count', operator: 'gt', threshold: 999, windowMs: 120_000 });

    service.recordRunFinish({
      workspaceId: 'ws',
      runId: 'run-1',
      status: 'completed',
      startedAt: clock,
      finishedAt: clock + 25,
    });

    assert.equal(summaryQueryCount, 10, 'five summary queries per distinct window');
  } finally {
    db.close();
  }
});

test('queue claims are leased, workspace-scoped and redacted in reads', () => {
  const { db, service } = serviceWithClock();
  try {
    const job = service.enqueueJob({ workspaceId: 'ws', goal: 'secret customer prompt', maxSteps: 2 });
    assert.equal(job.status, 'queued');
    assert.equal(job.goalDigest.length, 64);
    assert.equal(Object.hasOwn(job, 'goal'), false);
    const claimed = service.claimNextJob({ workerId: 'worker-1', leaseMs: 10_000 });
    assert.equal(claimed.jobId, job.jobId);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.goal, 'secret customer prompt');
    assert.equal(service.finishJob({ jobId: job.jobId, workspaceId: 'ws', workerId: 'worker-1', status: 'completed', runId: 'run-1' }).status, 'completed');
    const completed = service.queueSummary({ workspaceId: 'ws' });
    assert.deepEqual(completed.byStatus, { completed: 1 });
    assert.equal(completed.lagMs, 0);
    assert.equal(completed.oldestActiveAt, null);
  } finally {
    db.close();
  }
});

test('queue summary reports active depth and oldest-job lag', () => {
  const { db, service, advance } = serviceWithClock();
  try {
    service.enqueueJob({ workspaceId: 'ws', goal: 'private queue input', maxSteps: 1 });
    advance(250);
    const summary = service.queueSummary({ workspaceId: 'ws' });
    assert.equal(summary.depth, 1);
    assert.equal(summary.lagMs, 250);
    assert.equal(summary.oldestActiveAt, '2023-11-14T22:13:20.000Z');
  } finally {
    db.close();
  }
});

test('internal metrics expose bounded workspace-scoped health signals without recursive events', () => {
  const { db, service } = serviceWithClock();
  const dropped = service.subscribe(() => { throw new Error('subscriber sink down'); }, { workspaceId: 'ws-a' });
  const seen = [];
  const unsubscribe = service.subscribe(event => seen.push(event), { workspaceId: 'ws-a' });
  try {
    service.createAlertRule({ workspaceId: 'ws-a', name: 'failure', metric: 'error_count', operator: 'gt', threshold: 0, windowMs: 60_000, cooldownMs: 5_000 });
    service.recordRunFinish({ workspaceId: 'ws-a', runId: 'failed', status: 'failed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_100, errorSteps: 1 });
    service.recordStep({ workspaceId: 'ws-a', runId: 'failed', traceId: 'trace-a', tool: 'verify', status: 'done' });
    service.summary({ workspaceId: 'ws-a', windowMs: 60_000 });
    service.recordStep({ workspaceId: 'ws-b', runId: 'other', tool: 'privateTool', status: 'done' });

    const metrics = service.internalMetrics({ workspaceId: 'ws-a' });
    assert.equal(metrics.workspaceId, 'ws-a');
    assert.equal(metrics.subscriberCount, 2);
    assert.equal(metrics.eventWritesAttempted, undefined);
    assert.deepEqual(metrics.eventWrites, { attempted: 3, succeeded: 3, failed: 0 });
    assert.equal(metrics.droppedEvents, 3);
    assert.equal(metrics.projectionFailures, 0);
    assert.equal(metrics.summary.calls >= 1, true);
    assert.equal(metrics.summary.totalDurationMs >= 0, true);
    assert.equal(metrics.alertEvaluation.calls >= 1, true);
    assert.equal(metrics.alertEvaluation.failures, 0);
    assert.equal(seen.some(event => event.eventType === 'internal_metric'), false);
    assert.equal(service.internalMetrics({ workspaceId: 'ws-b' }).droppedEvents, 0);
  } finally {
    dropped();
    unsubscribe();
    db.close();
  }
});
