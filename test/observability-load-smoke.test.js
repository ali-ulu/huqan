'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertTargets,
  percentile,
  runBestOfLoadSmoke,
  runLoadSmoke,
  targetUtilisation,
} = require('../benchmarks/observability-load-smoke');
const DEFAULT_TARGETS = require('../benchmarks/fixtures/observability-load-targets.json');

// #1641: this suite blocks every merge, so it asserts only what is
// machine-independent. The wall-clock p95 targets are enforced by the
// benchmark job (runBestOfLoadSmoke), which measures somewhere we can reason
// about; on a busy shared runner the same commit measured 0.6 ms and 51 ms
// for queueClaim, which blocked #1544 twice on scheduler noise.
test('observability load smoke measures every P0.6 surface', () => {
  const report = runLoadSmoke({ enforceTargets: false });
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
  assert.equal(report.resources.queueLagMs, 0);
  assert.equal(report.resources.queueDepthAfter, 0);
  assert.equal(report.resources.sseEventsReceived, 6_400);
  assert.equal(Number.isInteger(report.resources.databaseTiming.calls), true);
  assert.equal(report.resources.databaseTiming.calls > 0, true);
  assert.equal(report.resources.databaseTiming.totalDurationMs >= 0, true);
  assert.equal(report.resources.databaseTiming.slowCalls <= report.resources.databaseTiming.calls, true);
  assertTargets(report, DEFAULT_TARGETS.targets, { latency: false });
});

test('observability load smoke fails closed when a target is exceeded', () => {
  const report = runLoadSmoke({ enforceTargets: false });
  assert.throws(
    () => assertTargets(report, { ...DEFAULT_TARGETS.targets, maxDbFileBytes: 0 }),
    /OBSERVABILITY_LOAD_TARGET_FAILED: dbFileBytes=/,
  );
});

test('latency targets still fail closed, on the surface that enforces them', () => {
  const report = runLoadSmoke({ enforceTargets: false });
  // #1869: isolate queueClaim so scheduler noise on other wall-clock
  // surfaces (e.g. listP95Ms) cannot mask or break this contract assertion.
  const isolated = {
    ...DEFAULT_TARGETS.targets,
    eventWriteP95Ms: Number.POSITIVE_INFINITY,
    listP95Ms: Number.POSITIVE_INFINITY,
    summaryP95Ms: Number.POSITIVE_INFINITY,
    sseFanoutP95Ms: Number.POSITIVE_INFINITY,
    maxQueueLagMs: Number.POSITIVE_INFINITY,
    queueClaimP95Ms: -1,
  };
  assert.throws(
    () => assertTargets(report, isolated),
    /OBSERVABILITY_LOAD_TARGET_FAILED:.*queueClaimP95Ms=/,
  );
  // ...and are skipped, not silently passed, when the caller opts out.
  assertTargets(report, isolated, { latency: false });
});

test('the best-of-N run reports every attempt, and asserts on the least contended one', () => {
  // enforceTargets stays off here for the same reason the rest of this suite
  // avoids wall-clock assertions: running under `npm test` concurrency is
  // itself a contended machine, and the first version of this test failed
  // there -- the exact flake it exists to prevent (#1641).
  const report = runBestOfLoadSmoke({ attempts: 2, enforceTargets: false });
  assert.equal(report.attempts.total, 2);
  assert.equal(report.attempts.targetUtilisation.length, 2);
  // The selected attempt is no worse than any attempt it was chosen from.
  // Compared at the artifact's own precision: attempts.targetUtilisation is
  // rounded to 6 decimals for the report, so an exact recomputation sits up to
  // half an ulp of that either side of it -- which failed this assertion about
  // half the time on the raw value.
  const round6 = value => Number(value.toFixed(6));
  const selected = round6(targetUtilisation(report, DEFAULT_TARGETS.targets));
  for (const utilisation of report.attempts.targetUtilisation) {
    assert.equal(selected <= utilisation, true, `${selected} > ${utilisation}`);
  }
});

test('a contended attempt does not decide the verdict', () => {
  // targetUtilisation ranks by the worst headroom, so a run whose queueClaim
  // sits at half its target ranks worse than one at a tenth of it -- which is
  // how noise gets discarded instead of failing the gate.
  const base = runLoadSmoke({ enforceTargets: false });
  const contended = { ...base, metrics: { ...base.metrics, queueClaim: { ...base.metrics.queueClaim, p95Ms: 12.5 } } };
  assert.equal(targetUtilisation(contended, DEFAULT_TARGETS.targets) > targetUtilisation(base, DEFAULT_TARGETS.targets), true);
});

test('p95 uses a deterministic nearest-rank sample', () => {
  assert.equal(percentile([5, 1, 4, 2, 3]), 5);
  assert.equal(percentile([5, 1, 4, 2, 3], 0.5), 3);
  assert.equal(percentile([], 0.95), 0);
});
