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
    // `runSoak` asserts the targets itself, so this file inherited a threshold
    // calibrated for a workload 66x larger than the one it runs: the fixture is
    // 20 cycles x 100 writes (~2.1s of wall time), this test is 3 x 10 (~20ms).
    //
    // cpuRatio is CPU time across all threads over wall time, so on a short
    // enough window it measures JIT and GC scheduling rather than this code.
    // Measured over 30 runs of each: the full benchmark lands in 0.50-0.64,
    // while this test config ranges 0.00-2.32 and crossed the 1.5 limit in 5 of
    // 30 runs. That is a flaky test, not a regression -- and it failed inside
    // the *setup* call on line 32, so the gate assertion below never ran.
    //
    // Every other target keeps its real value and has orders of magnitude of
    // headroom here (dbFileBytes, dbBytesPerEvent and queueLagMs are exactly
    // constant across runs). The CPU budget is still enforced where it can be
    // measured honestly: `.github/workflows/benchmark.yml` runs the full
    // benchmark with the unmodified fixture.
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

test('bounded soak gate fails closed on an exceeded resource target', () => {
  const report = runSoak({ config: TEST_CONFIG });
  // Based on TEST_CONFIG.targets, not the shipped fixture: spreading the
  // fixture here reintroduced the real maxCpuRatio, so a noisy run produced
  // "cpuRatio=..., dbFileBytes=..." and the anchored pattern below stopped
  // matching. The regex is likewise not anchored to the start of the message,
  // because this test is about dbFileBytes failing closed, not about it being
  // the only thing that failed.
  assert.throws(
    () => assertSoakTargets(report, { ...TEST_CONFIG.targets, maxDbFileBytes: 0 }),
    /OBSERVABILITY_SOAK_TARGET_FAILED:.*dbFileBytes=/,
  );
});

test('the gate still enforces cpuRatio, which this config only declines to measure', () => {
  // Relaxing maxCpuRatio in TEST_CONFIG is a statement about what a 20ms window
  // can measure, not a hole in the gate. If that distinction ever stopped being
  // true, the fixture change above would be silently disabling a check.
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
