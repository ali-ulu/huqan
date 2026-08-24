'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');

const DEFAULT_TARGETS = require('../benchmarks/observability-load-targets.json');

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
}

function measure(count, operation) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    operation(index);
    samples.push(performance.now() - started);
  }
  return p95(samples);
}

function assertTargets(metrics, targets) {
  const failures = [];
  for (const [name, maximum] of Object.entries(targets.p95TargetsMs)) {
    if (!Number.isFinite(metrics.p95Ms[name]) || metrics.p95Ms[name] > maximum) {
      failures.push(`${name} p95 ${metrics.p95Ms[name]}ms exceeds ${maximum}ms`);
    }
  }
  if (metrics.sqliteBytes > targets.maxSqliteBytes) {
    failures.push(`SQLite size ${metrics.sqliteBytes} exceeds ${targets.maxSqliteBytes} bytes`);
  }
  if (metrics.eventCount < targets.load.eventWrites + targets.load.queueClaims * 2) {
    failures.push(`event count ${metrics.eventCount} is incomplete`);
  }
  if (metrics.sseDeliveries !== targets.load.sseSubscribers) {
    failures.push(`SSE fan-out delivered ${metrics.sseDeliveries}/${targets.load.sseSubscribers}`);
  }
  if (failures.length) {
    const error = new Error(`Observability load targets failed: ${failures.join('; ')}`);
    error.code = 'OBSERVABILITY_LOAD_TARGET_FAILED';
    error.failures = failures;
    throw error;
  }
}

function runLoadSmoke({ targets = DEFAULT_TARGETS } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-load-'));
  const databasePath = path.join(directory, 'observability.sqlite');
  const db = new Database(databasePath);
  const workspaceId = 'load-smoke';
  try {
    db.pragma('journal_mode = WAL');
    const service = createObservabilityService({ db });
    const p95Ms = {};
    p95Ms.eventWrite = measure(targets.load.eventWrites, index => service.recordStep({
      workspaceId, runId: `run-${index}`, traceId: `trace-${index}`, tool: 'fixture-tool', status: 'completed', durationMs: 1,
    }));
    p95Ms.listEvents = measure(targets.load.listReads, () => service.listEvents({ workspaceId, limit: 100 }));
    p95Ms.summary = measure(targets.load.summaryReads, () => service.summary({ workspaceId }));

    let deliveries = 0;
    const unsubscribe = Array.from({ length: targets.load.sseSubscribers }, () => service.subscribe(() => { deliveries += 1; }));
    p95Ms.sseFanout = measure(1, () => service.recordStep({
      workspaceId, runId: 'fanout-run', traceId: 'fanout-trace', tool: 'fixture-tool', status: 'completed', durationMs: 1,
    }));
    unsubscribe.forEach(stop => stop());

    for (let index = 0; index < targets.load.queueClaims; index += 1) {
      service.enqueueJob({ workspaceId, jobId: `job-${index}`, goal: 'bounded fixture goal' });
    }
    p95Ms.queueClaim = measure(targets.load.queueClaims, index => service.claimNextJob({ workerId: `worker-${index}` }));
    db.pragma('wal_checkpoint(TRUNCATE)');
    const metrics = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      load: targets.load,
      p95TargetsMs: targets.p95TargetsMs,
      p95Ms: Object.fromEntries(Object.entries(p95Ms).map(([key, value]) => [key, Number(value.toFixed(3))])),
      sseDeliveries: deliveries,
      eventCount: db.prepare('SELECT COUNT(*) AS count FROM observability_events').get().count,
      queueCount: db.prepare('SELECT COUNT(*) AS count FROM agent_queue_jobs').get().count,
      sqliteBytes: fs.statSync(databasePath).size,
    };
    assertTargets(metrics, targets);
    return Object.freeze({ ...metrics, passed: true });
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(runLoadSmoke(), null, 2)}\n`); }
  catch (error) {
    process.stderr.write(`${error.code || 'OBSERVABILITY_LOAD_SMOKE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { assertTargets, measure, p95, runLoadSmoke };
