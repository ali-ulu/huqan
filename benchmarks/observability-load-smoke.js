'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DEFAULT_TARGETS = require('./fixtures/observability-load-targets.json');
const { createObservabilityService } = require('../lib/observability/service');

function percentile(samples, fraction = 0.95) {
  const values = [...samples].sort((left, right) => left - right);
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function measure(iterations, operation) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    operation(index);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    iterations,
    averageMs: total / iterations,
    p95Ms: percentile(samples),
    maxMs: Math.max(...samples),
  };
}

function assertTargets(report, targets) {
  const failures = [];
  const checks = [
    ['eventWriteP95Ms', report.metrics.eventWrite.p95Ms],
    ['listP95Ms', report.metrics.list.p95Ms],
    ['summaryP95Ms', report.metrics.summary.p95Ms],
    ['sseFanoutP95Ms', report.metrics.sseFanout.p95Ms],
    ['queueClaimP95Ms', report.metrics.queueClaim.p95Ms],
  ];
  for (const [name, value] of checks) {
    if (!Number.isFinite(value) || value > targets[name]) failures.push(`${name}=${value}`);
  }
  if (report.resources.dbFileBytes > targets.maxDbFileBytes) failures.push(`dbFileBytes=${report.resources.dbFileBytes}`);
  if (report.resources.queueLagMs > targets.maxQueueLagMs) failures.push(`queueLagMs=${report.resources.queueLagMs}`);
  const databaseTiming = report.resources.databaseTiming;
  if (!databaseTiming || !Number.isInteger(databaseTiming.calls) || databaseTiming.calls <= 0) failures.push(`databaseTiming.calls=${databaseTiming?.calls}`);
  if (!databaseTiming || !Number.isFinite(databaseTiming.totalDurationMs) || databaseTiming.totalDurationMs < 0) failures.push(`databaseTiming.totalDurationMs=${databaseTiming?.totalDurationMs}`);
  if (!databaseTiming || !Number.isInteger(databaseTiming.slowCalls) || databaseTiming.slowCalls < 0 || databaseTiming.slowCalls > databaseTiming.calls) failures.push(`databaseTiming.slowCalls=${databaseTiming?.slowCalls}`);
  if (report.resources.sseEventsReceived !== report.workload.ssePublishes * report.workload.sseSubscribers) {
    failures.push(`sseEventsReceived=${report.resources.sseEventsReceived}`);
  }
  if (failures.length) throw new Error(`OBSERVABILITY_LOAD_TARGET_FAILED: ${failures.join(', ')}`);
}

function runLoadSmoke({ targets = DEFAULT_TARGETS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-load-'));
  const dbPath = path.join(root, 'observability-load.db');
  const db = new Database(dbPath);
  const workspaceId = String(targets.workspaceId || 'observability-load-smoke');
  const service = createObservabilityService({ db });
  let sseEventsReceived = 0;
  let collectSseEvents = false;
  const unsubscribe = [];
  try {
    for (let index = 0; index < targets.eventWrites; index += 1) {
      service.recordStep({ workspaceId, runId: `seed-run-${index % 10}`, traceId: `seed-trace-${index % 10}`, tool: 'seed', status: 'done' });
    }
    for (let index = 0; index < targets.queueJobs; index += 1) {
      service.enqueueJob({ workspaceId, jobId: `load-job-${index}`, goal: 'deterministic load smoke', maxSteps: 1 });
    }
    for (let index = 0; index < targets.sseSubscribers; index += 1) {
      unsubscribe.push(service.subscribe(() => { if (collectSseEvents) sseEventsReceived += 1; }));
    }

    const queueBefore = service.queueSummary({ workspaceId });
    const metrics = {
      eventWrite: measure(targets.eventWrites, index => {
        service.recordStep({ workspaceId, runId: `write-run-${index % 10}`, traceId: `write-trace-${index % 10}`, tool: 'write', status: 'done' });
      }),
      list: measure(targets.listReads, () => {
        service.listEvents({ workspaceId, limit: 100 });
      }),
      summary: measure(targets.summaryReads, () => {
        service.summary({ workspaceId, windowMs: 24 * 60 * 60 * 1000 });
      }),
      sseFanout: (() => {
        collectSseEvents = true;
        try {
          return measure(targets.ssePublishes, index => {
            service.recordGateDecision({ workspaceId, runId: `sse-run-${index % 10}`, traceId: `sse-trace-${index % 10}`, gate: 'load-smoke', decision: 'allow' });
          });
        } finally {
          collectSseEvents = false;
        }
      })(),
      queueClaim: measure(targets.queueJobs, index => {
        const job = service.claimNextJob({ workerId: 'load-smoke-worker', leaseMs: 120_000 });
        if (!job) throw new Error(`OBSERVABILITY_LOAD_QUEUE_UNDERFLOW: index=${index}`);
        service.finishJob({ jobId: job.jobId, workspaceId, workerId: 'load-smoke-worker', status: 'completed', runId: `queue-run-${index}` });
      }),
    };
    db.pragma('wal_checkpoint(TRUNCATE)');
    const resources = {
      dbFileBytes: fs.statSync(dbPath).size,
      queueDepthBefore: queueBefore.depth,
      queueLagMs: queueBefore.lagMs,
      queueDepthAfter: service.queueSummary({ workspaceId }).depth,
      sseEventsReceived,
      databaseTiming: service.internalMetrics({ workspaceId }).database,
    };
    const report = {
      schemaVersion: 1,
      fixture: { name: targets.name, workspaceId },
      workload: {
        eventWrites: targets.eventWrites,
        listReads: targets.listReads,
        summaryReads: targets.summaryReads,
        ssePublishes: targets.ssePublishes,
        sseSubscribers: targets.sseSubscribers,
        queueJobs: targets.queueJobs,
      },
      metrics,
      resources,
      targets: targets.targets,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
    };
    assertTargets(report, targets.targets);
    return report;
  } finally {
    for (const close of unsubscribe) close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(runLoadSmoke(), null, 2)}\n`);
}

module.exports = { assertTargets, measure, percentile, runLoadSmoke };
