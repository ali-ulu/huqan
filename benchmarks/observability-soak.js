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

// better-sqlite3's N-API close() schedules its finalizer on a later macrotask,
// and each garbage collection of the closed handle can schedule another.
// Snapshotting the active-resource set before those turns report the driver's
// pending Immediate as a leak the observability workload never created, so
// interleave collection with event-loop turns until the immediate queue settles.
async function settleClosedDriver({ rounds = 4, maxTurnsPerRound = 16 } = {}) {
  const pendingImmediates = () => (typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo().filter((type) => type === 'Immediate').length
    : 0);
  for (let round = 0; round < rounds; round += 1) {
    collectGarbage();
    for (let turn = 0; turn < maxTurnsPerRound && pendingImmediates() > 0; turn += 1) {
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  }
}

function sqliteFootprint(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
}

function countTypes(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value || 'Unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function openFileDescriptorCount() {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch (_) {
    return null;
  }
}

function activeHandleTypeNames() {
  if (typeof process._getActiveHandles !== 'function') return [];
  return process._getActiveHandles().map((handle) => handle?.constructor?.name || 'Unknown');
}

function resourceSnapshot({ cycle, subscriberCount = 0, sqliteOpen = false } = {}) {
  const memory = process.memoryUsage();
  // An Immediate is one-shot and drains on the next loop turn, so it cannot
  // be a leak. better-sqlite3's close finalizer schedules one (see
  // settleClosedDriver), and settling can still lose that race, which made the
  // leak gate flap. Timeouts and handles still count.
  const activeResourceTypes = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo().filter((type) => type !== 'Immediate')
    : [];
  const activeHandleTypes = activeHandleTypeNames();
  const activeResources = countTypes(activeResourceTypes);
  const activeHandles = countTypes(activeHandleTypes);
  return {
    cycle,
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    openFileDescriptors: openFileDescriptorCount(),
    activeResourceCount: activeResourceTypes.length,
    activeResources,
    activeHandleCount: activeHandleTypes.length,
    activeHandles,
    timerCount: activeResources.Timeout || 0,
    childProcessCount: activeHandles.ChildProcess || 0,
    subscriberCount,
    sqliteOpen: Boolean(sqliteOpen),
  };
}

function linearSlope(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const x = index - xMean;
    numerator += x * (values[index] - yMean);
    denominator += x * x;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function curveSummary(samples) {
  const stableSamples = samples.length > 4 ? samples.slice(2) : samples;
  const heap = stableSamples.map((sample) => sample.heapUsedBytes);
  const rss = stableSamples.map((sample) => sample.rssBytes);
  return {
    sampleCount: samples.length,
    warmupSamplesExcluded: samples.length - stableSamples.length,
    heapSlopeBytesPerCycle: linearSlope(heap),
    rssSlopeBytesPerCycle: linearSlope(rss),
    heapMinBytes: heap.length ? Math.min(...heap) : 0,
    heapMaxBytes: heap.length ? Math.max(...heap) : 0,
    rssMinBytes: rss.length ? Math.min(...rss) : 0,
    rssMaxBytes: rss.length ? Math.max(...rss) : 0,
  };
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
    ['heapSlopeBytesPerCycle', report.resources.curve.heapSlopeBytesPerCycle, targets.maxHeapSlopeBytesPerCycle],
    ['rssSlopeBytesPerCycle', report.resources.curve.rssSlopeBytesPerCycle, targets.maxRssSlopeBytesPerCycle],
    ['activeResourceDeltaAfterCleanup', report.resources.lifecycle.activeResourceDeltaAfterCleanup, targets.maxActiveResourceDeltaAfterCleanup],
    ['activeHandleDeltaAfterCleanup', report.resources.lifecycle.activeHandleDeltaAfterCleanup, targets.maxActiveHandleDeltaAfterCleanup],
    ['timerDeltaAfterCleanup', report.resources.lifecycle.timerDeltaAfterCleanup, targets.maxTimerDeltaAfterCleanup],
    ['childProcessDeltaAfterCleanup', report.resources.lifecycle.childProcessDeltaAfterCleanup, targets.maxChildProcessDeltaAfterCleanup],
  ];
  for (const [name, value, limit] of checks) {
    if (!Number.isFinite(value) || value > limit) failures.push(`${name}=${value} (max ${limit})`);
  }
  if (report.runtime.procFdAvailable
      && (!Number.isFinite(report.resources.lifecycle.openFileDescriptorDeltaAfterCleanup)
        || report.resources.lifecycle.openFileDescriptorDeltaAfterCleanup > targets.maxOpenFileDescriptorDeltaAfterCleanup)) {
    failures.push(`openFileDescriptorDeltaAfterCleanup=${report.resources.lifecycle.openFileDescriptorDeltaAfterCleanup} (max ${targets.maxOpenFileDescriptorDeltaAfterCleanup})`);
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
  if (report.resources.lifecycle.sqliteConnectionOpenAfterClose !== false) {
    failures.push('sqliteConnectionOpenAfterClose=true');
  }
  if (failures.length) throw new Error(`OBSERVABILITY_SOAK_TARGET_FAILED: ${failures.join(', ')}`);
}

async function runSoak({ config = DEFAULT_CONFIG } = {}) {
  collectGarbage();
  const baseline = resourceSnapshot({ cycle: -1, subscriberCount: 0, sqliteOpen: false });
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
  const resourceSamples = [];
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
      collectGarbage();
      resourceSamples.push(resourceSnapshot({
        cycle,
        subscriberCount: service.internalMetrics({ workspaceId }).subscriberCount,
        sqliteOpen: db.open,
      }));
    }
    for (const close of longLivedClosers.splice(0)) close();
    const wallMs = Number(process.hrtime.bigint() - wallBefore) / 1e6;
    const cpu = process.cpuUsage(cpuBefore);
    const cpuTimeMs = (cpu.user + cpu.system) / 1000;
    collectGarbage();
    const heapAfter = process.memoryUsage().heapUsed;
    db.pragma('wal_checkpoint(TRUNCATE)');
    const queue = service.queueSummary({ workspaceId });
    const metricsBeforeClose = service.internalMetrics({ workspaceId });
    const totalPublishedEvents = config.cycles * (config.eventWritesPerCycle + config.queueJobsPerCycle);
    const eventWrites = config.cycles * config.eventWritesPerCycle;
    const dbFileBytes = sqliteFootprint(dbPath);
    const beforeCleanup = resourceSnapshot({
      cycle: config.cycles,
      subscriberCount: metricsBeforeClose.subscriberCount,
      sqliteOpen: db.open,
    });
    const sqliteConnectionOpenBeforeClose = db.open;
    db.close();
    await settleClosedDriver();
    const afterCleanup = resourceSnapshot({
      cycle: config.cycles + 1,
      subscriberCount: 0,
      sqliteOpen: db.open,
    });
    const report = {
      schemaVersion: 2,
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
        dbFileBytes,
        dbBytesPerEvent: dbFileBytes / totalPublishedEvents,
        queueDepth: queue.depth,
        queueLagMs: queue.lagMs,
        databaseTiming: metricsBeforeClose.database,
        curve: curveSummary(resourceSamples),
        samples: resourceSamples,
        lifecycle: {
          baseline,
          beforeCleanup,
          afterCleanup,
          sqliteConnectionOpenBeforeClose,
          sqliteConnectionOpenAfterClose: db.open,
          openFileDescriptorDeltaAfterCleanup: Number.isFinite(baseline.openFileDescriptors)
            && Number.isFinite(afterCleanup.openFileDescriptors)
            ? afterCleanup.openFileDescriptors - baseline.openFileDescriptors
            : null,
          activeResourceDeltaAfterCleanup: afterCleanup.activeResourceCount - baseline.activeResourceCount,
          activeHandleDeltaAfterCleanup: afterCleanup.activeHandleCount - baseline.activeHandleCount,
          timerDeltaAfterCleanup: afterCleanup.timerCount - baseline.timerCount,
          childProcessDeltaAfterCleanup: afterCleanup.childProcessCount - baseline.childProcessCount,
        },
      },
      reconnect: {
        cycles: config.cycles,
        peakSubscriberCount,
        subscriberCountAfter: metricsBeforeClose.subscriberCount,
        longLivedDeliveries,
        expectedLongLivedDeliveries: totalPublishedEvents * config.longLivedSubscribers,
        reconnectedDeliveries,
        expectedReconnectedDeliveries: totalPublishedEvents * config.reconnectingSubscribersPerCycle,
      },
      targets: config.targets,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        gcExposed: typeof global.gc === 'function',
        activeResourceInfoAvailable: typeof process.getActiveResourcesInfo === 'function',
        activeHandleInspectionAvailable: typeof process._getActiveHandles === 'function',
        procFdAvailable: baseline.openFileDescriptors !== null,
      },
    };
    assertSoakTargets(report, config.targets);
    return report;
  } finally {
    for (const close of longLivedClosers) close();
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (require.main === module) {
  runSoak()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  assertSoakTargets,
  curveSummary,
  resourceSnapshot,
  runSoak,
  sqliteFootprint,
};
