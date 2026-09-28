'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DEFAULT_CONFIG = require('../benchmarks/fixtures/observability-soak-targets.json');
const { assertSoakTargets, runSoak } = require('../benchmarks/observability-soak');

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  name: 'observability-bounded-soak-test',
  cycles: 3,
  eventWritesPerCycle: 10,
  queueJobsPerCycle: 2,
  longLivedSubscribers: 2,
  reconnectingSubscribersPerCycle: 1,
  targets: {
    ...DEFAULT_CONFIG.targets,
    maxCpuRatio: Number.POSITIVE_INFINITY,
  },
};

test('bounded soak proves queue growth, reconnect completeness, and subscriber cleanup', () => {
  const report = runSoak({ config: TEST_CONFIG });
  assert.equal(report.workload.eventWrites, 30);
  assert.equal(report.workload.queueJobs, 6);
  assert.equal(report.resources.queueDepth, 6);
  assert.equal(report.resources.queueLagMs, 750);
  assert.equal(report.reconnect.peakSubscriberCount, 3);
  assert.equal(report.reconnect.subscriberCountAfter, 0);
  assert.equal(report.reconnect.longLivedDeliveries, 72);
  assert.equal(report.reconnect.reconnectedDeliveries, 36);
  assert.equal(report.resources.databaseTiming.calls > 0, true);
});

test('bounded soak publishes sampled process-resource and cleanup evidence', () => {
  const report = runSoak({ config: TEST_CONFIG });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.resources.samples.length, TEST_CONFIG.cycles);
  assert.equal(report.resources.curve.sampleCount, TEST_CONFIG.cycles);
  assert.equal(Number.isFinite(report.resources.curve.heapSlopeBytesPerCycle), true);
  assert.equal(Number.isFinite(report.resources.curve.rssSlopeBytesPerCycle), true);
  assert.equal(report.resources.lifecycle.sqliteConnectionOpenBeforeClose, true);
  assert.equal(report.resources.lifecycle.sqliteConnectionOpenAfterClose, false);
  assert.equal(report.resources.lifecycle.beforeCleanup.subscriberCount, 0);
  assert.equal(report.resources.lifecycle.afterCleanup.subscriberCount, 0);
  assert.equal(report.resources.lifecycle.afterCleanup.childProcessCount >= 0, true);
  assert.equal(report.resources.lifecycle.afterCleanup.timerCount >= 0, true);
  assert.equal(typeof report.resources.lifecycle.afterCleanup.activeResources, 'object');
  assert.equal(typeof report.resources.lifecycle.afterCleanup.activeHandles, 'object');
});

test('bounded soak gate fails closed on an exceeded resource target', () => {
  const report = runSoak({ config: TEST_CONFIG });
  assert.throws(
    () => assertSoakTargets(report, { ...TEST_CONFIG.targets, maxDbFileBytes: 0 }),
    /OBSERVABILITY_SOAK_TARGET_FAILED:.*dbFileBytes=/,
  );
});

test('bounded soak gate fails closed if SQLite is not closed', () => {
  const report = runSoak({ config: TEST_CONFIG });
  report.resources.lifecycle.sqliteConnectionOpenAfterClose = true;
  assert.throws(
    () => assertSoakTargets(report, TEST_CONFIG.targets),
    /OBSERVABILITY_SOAK_TARGET_FAILED:.*sqliteConnectionOpenAfterClose=true/,
  );
});

test('the gate still enforces cpuRatio, which this config only declines to measure', () => {
  const report = runSoak({ config: TEST_CONFIG });

  assert.throws(
    () => assertSoakTargets(report, { ...TEST_CONFIG.targets, maxCpuRatio: -1 }),
    /OBSERVABILITY_SOAK_TARGET_FAILED:.*cpuRatio=/,
  );
  assert.equal(
    Number.isFinite(DEFAULT_CONFIG.targets.maxCpuRatio),
    true,
    'the shipped fixture must keep a real CPU budget for the full benchmark',
  );
});
