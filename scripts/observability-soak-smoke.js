'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');
const targetsDefault = require('../benchmarks/observability-soak-targets.json');
const { p95 } = require('./observability-load-smoke');

function assertSoak(report, targets) {
  const failures = [];
  if (report.subscribersAfter !== 0) failures.push(`subscriber leak: ${report.subscribersAfter}`);
  if (report.deliveries !== report.expectedDeliveries) failures.push(`SSE delivery mismatch: ${report.deliveries}/${report.expectedDeliveries}`);
  if (report.heapGrowthBytes > targets.maxHeapGrowthBytes) failures.push(`heap growth ${report.heapGrowthBytes} > ${targets.maxHeapGrowthBytes}`);
  if (report.sqliteBytesPerEvent > targets.maxSqliteBytesPerEvent) failures.push(`SQLite/event ${report.sqliteBytesPerEvent} > ${targets.maxSqliteBytesPerEvent}`);
  if (report.queueLagMs > targets.maxQueueLagMs) failures.push(`queue lag ${report.queueLagMs} > ${targets.maxQueueLagMs}`);
  if (report.cycleP95Ms > targets.maxCycleP95Ms) failures.push(`cycle p95 ${report.cycleP95Ms} > ${targets.maxCycleP95Ms}`);
  if (failures.length) throw Object.assign(new Error(failures.join('; ')), { code: 'OBSERVABILITY_SOAK_TARGET_FAILED', failures });
}

function runSoak({ targets = targetsDefault } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-soak-'));
  const databasePath = path.join(directory, 'observability.sqlite');
  const db = new Database(databasePath);
  let clock = 1_700_000_000_000;
  try {
    db.pragma('journal_mode = WAL');
    const service = createObservabilityService({ db, now: () => clock });
    const heapStart = process.memoryUsage().heapUsed;
    const cycleSamples = [];
    let deliveries = 0;
    for (let cycle = 0; cycle < targets.load.cycles; cycle += 1) {
      const started = performance.now();
      const stops = Array.from({ length: targets.load.subscribersPerCycle }, () => service.subscribe(() => { deliveries += 1; }));
      for (let index = 0; index < targets.load.eventsPerCycle; index += 1) service.recordStep({ workspaceId: 'soak', runId: `run-${cycle}-${index}`, traceId: `trace-${cycle}`, tool: 'fixture', status: 'completed' });
      stops.forEach(stop => stop());
      for (let index = 0; index < targets.load.queueJobsPerCycle; index += 1) service.enqueueJob({ workspaceId: 'soak', jobId: `job-${cycle}-${index}`, goal: 'bounded fixture' });
      clock += 10;
      cycleSamples.push(performance.now() - started);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    const internal = service.internalMetrics();
    const eventCount = db.prepare('SELECT COUNT(*) AS count FROM observability_events').get().count;
    const sqliteBytes = fs.statSync(databasePath).size;
    const report = {
      schemaVersion: 1, generatedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
      load: targets.load, cycleP95Ms: Number(p95(cycleSamples).toFixed(3)), heapGrowthBytes: Math.max(0, process.memoryUsage().heapUsed - heapStart),
      sqliteBytes, sqliteBytesPerEvent: Number((sqliteBytes / eventCount).toFixed(2)), eventCount,
      deliveries, expectedDeliveries: targets.load.cycles * targets.load.eventsPerCycle * targets.load.subscribersPerCycle,
      subscribersAfter: internal.gauges.subscribers, queueLagMs: internal.gauges.queueLagMs,
    };
    assertSoak(report, targets);
    return Object.freeze({ ...report, passed: true });
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(runSoak(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.code || 'OBSERVABILITY_SOAK_FAILED'}: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { assertSoak, runSoak };
