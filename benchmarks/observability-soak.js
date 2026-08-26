'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DEFAULT_CONFIG = require('./fixtures/observability-soak-targets.json');
const { percentile } = require('./observability-load-smoke');
const { createObservabilityService } = require('../lib/observability/service');

function collectGarbage() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
}

function sqliteFootprint(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
}

function assertSoakTargets(report, targets) {
  const failures = [];
  const checks = [
    ['eventWriteP95Ms', report.metrics.eventWriteP95Ms, targets.eventWriteP95Ms],
    ['heapGrowthBytes', report.resources.heapGrowthBytes, targets.maxHeapGrowthBytes],
    ['cpuTimeMs', report.resources.cpuTimeMs, targets.maxCpuTimeMs],
    ['cpuRatio', report.resources.cpuRatio, targets.maxCpuRatio],
    ['dbFileBytes', report.resources.dbFileBytes, targets.maxDbFileBytes],
    ['dbBytesPerEvent', report.resources.dbBytesPerEvent, targets.maxDbBytesPerEvent],
    ['queueLagMs', report.resources.queueLagMs, targets.maxQueueLagMs],
    ['subscriberCountAfter', report.reconnect.subscriberCountAfter, targets.maxSubscriberCountAfter],
  ];
  for (const [name, value, limit] of checks) {
    if (!Number.isFinite(value) || value > limit) failures.push(`${name}=${value} (max ${limit})`);
  }
  if (report.reconnect.longLivedDeliveries !== report.reconnect.expectedLongLivedDeliveries) {
    failures.push(`longLivedDeliveries=${report.reconnect.longLivedDeliveries}`);
  }
  if (report.reconnect.reconnectedDeliveries !== report.reconnect.expectedReconnectedDeliveries) {
    failures.push(`reconnectedDeliveries=${report.reconnect.reconnectedDeliveries}`);
  }
  if (report.resources.queueDepth !== report.workload.queueJobs) {
    failures.push(`queueDepth=${report.resources.queueDepth}`);
  }
  if (failures.length) throw new Error(`OBSERVABILITY_SOAK_TARGET_FAILED: ${failures.join(', ')}`);
}

function runSoak({ config = DEFAULT_CONFIG } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-soak-'));
  const dbPath = path.join(root, 'observability-soak.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  const workspaceId = String(config.workspaceId || 'observability-soak');
  let logicalNow = Date.UTC(2026, 0, 1);
  const service = createObservabilityService({ db, now: () => logicalNow });
  const longLivedClosers = [];
  let longLivedDeliveries = 0;
  let reconnectedDeliveries = 0;
  let peakSubscriberCount = 0;
  const writeSamples = [];
  try {
    collectGarbage();
    const heapBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();
    const wallBefore = process.hrtime.bigint();
    for (let index = 0; index < config.longLivedSubscribers; index += 1) {
      longLivedClosers.push(service.subscribe(() => { longLivedDeliveries += 1; }, { workspaceId }));
    }
    for (let cycle = 0; cycle < config.cycles; cycle += 1) {
      const reconnectClosers = [];
      for (let index = 0; index < config.reconnectingSubscribersPerCycle; index += 1) {
        reconnectClosers.push(service.subscribe(() => { reconnectedDeliveries += 1; }, { workspaceId }));
      }
      peakSubscriberCount = Math.max(peakSubscriberCount, service.internalMetrics({ workspaceId }).subscriberCount);
      for (let index = 0; index < config.eventWritesPerCycle; index += 1) {
        const started = process.hrtime.bigint();
        service.recordStep({
          workspaceId,
          runId: `soak-run-${cycle}-${index % 10}`,
          traceId: `soak-trace-${cycle}-${index}`,
          tool: 'soak',
          status: 'done',
        });
        writeSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      for (let index = 0; index < config.queueJobsPerCycle; index += 1) {
        service.enqueueJob({
          workspaceId,
          jobId: `soak-job-${cycle}-${index}`,
          goal: 'bounded observability soak',
          maxSteps: 1,
        });
      }
      for (const close of reconnectClosers) close();
      logicalNow += config.logicalCycleMs;
    }
    for (const close of longLivedClosers.splice(0)) close();
    const wallMs = Number(process.hrtime.bigint() - wallBefore) / 1e6;
    const cpu = process.cpuUsage(cpuBefore);
    const cpuTimeMs = (cpu.user + cpu.system) / 1000;
    collectGarbage();
    const heapAfter = process.memoryUsage().heapUsed;
    db.pragma('wal_checkpoint(TRUNCATE)');
    const queue = service.queueSummary({ workspaceId });
    const totalPublishedEvents = config.cycles * (config.eventWritesPerCycle + config.queueJobsPerCycle);
    const eventWrites = config.cycles * config.eventWritesPerCycle;
    const report = {
      schemaVersion: 1,
      fixture: { name: config.name, workspaceId },
      workload: {
        cycles: config.cycles,
        eventWrites,
        queueJobs: config.cycles * config.queueJobsPerCycle,
        totalPublishedEvents,
        longLivedSubscribers: config.longLivedSubscribers,
        reconnectingSubscribersPerCycle: config.reconnectingSubscribersPerCycle,
      },
      metrics: {
        eventWriteP95Ms: percentile(writeSamples),
        eventWriteMaxMs: Math.max(...writeSamples),
      },
      resources: {
        wallMs,
        cpuTimeMs,
        cpuRatio: wallMs === 0 ? 0 : cpuTimeMs / wallMs,
        heapBeforeBytes: heapBefore,
        heapAfterBytes: heapAfter,
        heapGrowthBytes: Math.max(0, heapAfter - heapBefore),
        dbFileBytes: sqliteFootprint(dbPath),
        dbBytesPerEvent: sqliteFootprint(dbPath) / totalPublishedEvents,
        queueDepth: queue.depth,
        queueLagMs: queue.lagMs,
        databaseTiming: service.internalMetrics({ workspaceId }).database,
      },
      reconnect: {
        cycles: config.cycles,
        peakSubscriberCount,
        subscriberCountAfter: service.internalMetrics({ workspaceId }).subscriberCount,
        longLivedDeliveries,
        expectedLongLivedDeliveries: totalPublishedEvents * config.longLivedSubscribers,
        reconnectedDeliveries,
        expectedReconnectedDeliveries: totalPublishedEvents * config.reconnectingSubscribersPerCycle,
      },
      targets: config.targets,
      runtime: { node: process.version, platform: process.platform, arch: process.arch, gcExposed: typeof global.gc === 'function' },
    };
    assertSoakTargets(report, config.targets);
    return report;
  } finally {
    for (const close of longLivedClosers) close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (require.main === module) process.stdout.write(`${JSON.stringify(runSoak(), null, 2)}\n`);

module.exports = { assertSoakTargets, runSoak, sqliteFootprint };
