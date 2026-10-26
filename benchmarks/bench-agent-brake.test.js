'use strict';

// The benchmark publishes a claim, so its checks are tested: not the timings,
// which depend on the machine, but that every unauthorized action was stopped,
// nothing reached the file, and every receipt verifies from disk.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runBenchmark, printReport, UNAUTHORIZED } = require('./bench-agent-brake');

test('every unauthorized action is stopped and every receipt verifies', () => {
  const report = runBenchmark({ iterations: 2 });

  assert.deepEqual(Object.entries(report.checks).filter(([, ok]) => ok !== true), []);
  assert.equal(report.checks.unmeasuredDecisionsHold, true);
  for (const action of report.actions) {
    assert.equal(action.executable, 0, `${action.name} was executable`);
    assert.equal(action.wrongAnswer, 0, `${action.name} did not get ${action.expect}`);
  }
  // cold call + warmup + measured runs, each one receipt on disk
  assert.equal(report.decisions, 1 + UNAUTHORIZED.length * (5 + 2));
  assert.equal(report.trail.written, report.decisions);
  assert.equal(report.trail.verified, report.decisions);
  assert.equal(report.trail.tamperedRejected, true);
  assert.ok(report.overall.p50Ms > 0);
});

test('a failed check is named in the report', () => {
  const report = runBenchmark({ iterations: 1 });
  const lines = [];
  const failed = printReport({ ...report, checks: { ...report.checks, fileUntouched: false } }, (l) => lines.push(l));

  assert.deepEqual(failed, ['fileUntouched']);
  assert.equal(lines.at(-1), 'bench FAILED: fileUntouched');
});

test('iterations must be a positive integer', () => {
  assert.throws(() => runBenchmark({ iterations: 0 }), TypeError);
});
