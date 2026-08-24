'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTargets, runBaseline } = require('../benchmarks/observability-agent-v3-baseline');

test('real AgentV3 baseline emits correlated, complete and private observability', () => {
  const report = runBaseline();
  assert.equal(report.eventCompleteness, 1);
  assert.equal(report.metrics.totalRuns, 3);
  assert.equal(report.metrics.successRate, 1);
  assert.equal(report.metrics.tokenKnown, true);
  assert.equal(report.metrics.costKnown, true);
  assert.equal(report.queue.depth, 1);
  assert.equal(report.runs.every(run => run.complete), true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(FIXTURE_SECRET), false);
});

test('baseline fails closed when a target regresses', () => {
  const report = runBaseline();
  assert.throws(() => assertTargets(report, {
    ...report.targets,
    maxP95LatencyMs: -1,
  }), /OBSERVABILITY_BASELINE_TARGET_FAILED: p95LatencyMs/);
});

const FIXTURE_SECRET = 'private baseline queue input';
