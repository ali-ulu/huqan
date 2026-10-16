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

const LATENCY_CHECKS = Object.freeze([
  ['eventWriteP95Ms', report => report.metrics.eventWrite.p95Ms],
  ['listP95Ms', report => report.metrics.list.p95Ms],
  ['summaryP95Ms', report => report.metrics.summary.p95Ms],
  ['sseFanoutP95Ms', report => report.metrics.sseFanout.p95Ms],
  ['queueClaimP95Ms', report => report.metrics.queueClaim.p95Ms],
]);

/**
 * How far the least-headroom latency sits from its target. Lower is a
 * less contended run; used to pick the best attempt (#1641).
 */
function targetUtilisation(report, targets) {
  return Math.max(...LATENCY_CHECKS.map(([name, read]) => {
    const value = read(report);
    if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
    return value / targets[name];
  }));
}

/**
 * `latency` opts into the wall-clock assertions (#1641). They belong to the
 * benchmark job, which measures on a machine we can reason about; the merge
 * blocking test suite asserts only what is machine-independent. On a busy
 * shared runner the same commit measures 0.6 ms or 51 ms for queueClaim, so
 * an absolute threshold there fails on scheduler noise while being far too
 * loose to catch a real regression.
 */
function assertTargets(report, targets, { latency = true } = {}) {
  const failures = [];
  if (latency) {
    for (const [name, read] of LATENCY_CHECKS) {
      const value = read(report);
      if (!Number.isFinite(value) || value > targets[name]) failures.push(`${name}=${value}`);
    }
    if (report.resources.queueLagMs > targets.maxQueueLagMs) failures.push(`queueLagMs=${report.resources.queueLagMs}`);
  }
  if (report.resources.dbFileBytes > targets.maxDbFileBytes) failures.push(`dbFileBytes=${report.resources.dbFileBytes}`);
  const databaseTiming = report.resources.databaseTiming;
  if (!databaseTiming || !Number.isInteger(databaseTiming.calls) || databaseTiming.calls <= 0) failures.push(`databaseTiming.calls=${databaseTiming?.calls}`);
  if (!databaseTiming || !Number.isFinite(databaseTiming.totalDurationMs) || databaseTiming.totalDurationMs < 0) failures.push(`databaseTiming.totalDurationMs=${databaseTiming?.totalDurationMs}`);
  if (!databaseTiming || !Number.isInteger(databaseTiming.slowCalls) || databaseTiming.slowCalls < 0 || databaseTiming.slowCalls > databaseTiming.calls) failures.push(`databaseTiming.slowCalls=${databaseTiming?.slowCalls}`);
  if (report.resources.sseEventsReceived !== report.workload.ssePublishes * report.workload.sseSubscribers) {
    failures.push(`sseEventsReceived=${report.resources.sseEventsReceived}`);
  }
  if (failures.length) throw new Error(`OBSERVABILITY_LOAD_TARGET_FAILED: ${failures.join(', ')}`);
}

function runLoadSmoke({ targets = DEFAULT_TARGETS, enforceTargets = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-load-'));
  const dbPath = path.join(root, 'observability-load.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  const workspaceId = String(targets.workspaceId || 'observability-load-smoke');
  const logicalNow = Date.UTC(2026, 0, 1);
  const service = createObservabilityService({ db, now: () => logicalNow });
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
    if (enforceTargets) assertTargets(report, targets.targets);
    return report;
  } finally {
    for (const close of unsubscribe) close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * Run the smoke several times and assert on the least contended attempt.
 *
 * The workload is fixed, so contention can only inflate a measurement, never
 * deflate it: the lowest attempt is the closest estimate of what the code
 * actually costs. Noise shows up in one attempt, a real regression in all of
 * them (#1641).
 */
function runBestOfLoadSmoke({ targets = DEFAULT_TARGETS, attempts = 3, enforceTargets = true } = {}) {
  const total = Math.max(1, Math.floor(Number(attempts) || 1));
  const reports = [];
  for (let index = 0; index < total; index += 1) {
    reports.push(runLoadSmoke({ targets, enforceTargets: false }));
  }
  let best = reports[0];
  for (const report of reports) {
    if (targetUtilisation(report, targets.targets) < targetUtilisation(best, targets.targets)) best = report;
  }
  const selected = {
    ...best,
    attempts: {
      total,
      // Every attempt's worst utilisation, so an artifact reader can tell a
      // contended runner (a wide spread) from a real regression (all high).
      targetUtilisation: reports.map(report => Number(targetUtilisation(report, targets.targets).toFixed(6))),
    },
  };
  if (enforceTargets) assertTargets(selected, targets.targets);
  return selected;
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(runBestOfLoadSmoke(), null, 2)}\n`);
}

module.exports = { assertTargets, measure, percentile, runBestOfLoadSmoke, runLoadSmoke, targetUtilisation };
