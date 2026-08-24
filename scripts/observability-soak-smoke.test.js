'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const committed = require('../benchmarks/observability-soak-report.json');
const targets = require('../benchmarks/observability-soak-targets.json');
const { assertSoak, runSoak } = require('./observability-soak-smoke');

test('bounded soak releases every subscriber and stays within resource targets', () => {
  const report = runSoak({ targets: { ...targets, maxSqliteBytesPerEvent: 10_000, load: { cycles: 3, eventsPerCycle: 3, subscribersPerCycle: 4, queueJobsPerCycle: 2 } } });
  assert.equal(report.passed, true);
  assert.equal(report.subscribersAfter, 0);
  assert.equal(report.deliveries, report.expectedDeliveries);
});

test('committed soak report satisfies current targets', () => {
  assert.doesNotThrow(() => assertSoak(committed, targets));
  assert.equal(committed.passed, true);
});
