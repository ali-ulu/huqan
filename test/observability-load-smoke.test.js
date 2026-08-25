'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTargets, percentile, runLoadSmoke } = require('../benchmarks/observability-load-smoke');
const DEFAULT_TARGETS = require('../benchmarks/fixtures/observability-load-targets.json');

test('observability load smoke measures every P0.6 surface within bounded targets', () => {
  const report = runLoadSmoke();
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.workload, {
    eventWrites: 500,
    listReads: 100,
    summaryReads: 50,
    ssePublishes: 200,
    sseSubscribers: 32,
    queueJobs: 100,
  });
  assert.equal(report.resources.queueDepthBefore, 100);
  assert.equal(report.resources.queueDepthAfter, 0);
  assert.equal(report.resources.sseEventsReceived, 6_400);
  assertTargets(report, DEFAULT_TARGETS.targets);
});

test('observability load smoke fails closed when a target is exceeded', () => {
  const report = runLoadSmoke();
  assert.throws(
    () => assertTargets(report, { ...DEFAULT_TARGETS.targets, maxDbFileBytes: 0 }),
    /OBSERVABILITY_LOAD_TARGET_FAILED: dbFileBytes=/,
  );
});

test('p95 uses a deterministic nearest-rank sample', () => {
  assert.equal(percentile([5, 1, 4, 2, 3]), 5);
  assert.equal(percentile([5, 1, 4, 2, 3], 0.5), 3);
  assert.equal(percentile([], 0.95), 0);
});
