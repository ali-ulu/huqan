'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const committedReport = require('../benchmarks/observability-load-report.json');
const { assertTargets, p95, runLoadSmoke } = require('./observability-load-smoke');

test('p95 uses the nearest-rank result', () => {
  assert.equal(p95(Array.from({ length: 100 }, (_, index) => index + 1)), 95);
});

test('load target failures are bounded and machine-readable', () => {
  assert.throws(() => assertTargets({
    p95Ms: { eventWrite: 11 }, sqliteBytes: 1, eventCount: 2, sseDeliveries: 1,
  }, {
    p95TargetsMs: { eventWrite: 10 }, maxSqliteBytes: 10,
    load: { eventWrites: 1, queueClaims: 1, sseSubscribers: 1 },
  }), { code: 'OBSERVABILITY_LOAD_TARGET_FAILED' });
});

test('observability staging load meets committed p95 and volume targets', { timeout: 30_000 }, () => {
  const report = runLoadSmoke();
  assert.equal(report.passed, true);
  assert.equal(report.queueCount, report.load.queueClaims);
});

test('committed load report satisfies the same acceptance targets', () => {
  assert.doesNotThrow(() => assertTargets(committedReport, {
    p95TargetsMs: committedReport.p95TargetsMs,
    maxSqliteBytes: 16_777_216,
    load: committedReport.load,
  }));
  assert.equal(committedReport.passed, true);
});
