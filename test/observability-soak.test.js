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

test('bounded soak gate fails closed on an exceeded resource target', () => {
  const report = runSoak({ config: TEST_CONFIG });
  assert.throws(
    () => assertSoakTargets(report, { ...DEFAULT_CONFIG.targets, maxDbFileBytes: 0 }),
    /OBSERVABILITY_SOAK_TARGET_FAILED: dbFileBytes=/,
  );
});
