'use strict';

// #3503 (R46 E3): smoke for the capacity envelope wrapper. Runs the smallest
// contention shape through a subprocess and asserts the report shape only --
// deliberately NO SLO assertion, so a noisy runner cannot flake this test.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const benchPath = path.join(__dirname, 'bench-capacity-envelope.js');

function runBench(args) {
  return spawnSync(process.execPath, [benchPath, ...args], { encoding: 'utf8', timeout: 300000 });
}

describe('bench-capacity-envelope (#3503)', () => {
  it('smoke reports the envelope shape (p50/p95/p99, busy, rss, wal, restart, slo)', () => {
    const result = runBench(['--writes=2', '--children=1,2']);
    if (result.status !== 0 && /sqlite/i.test(result.stderr)) {
      // better-sqlite3 unavailable: the backend guard fails the run by design.
      return;
    }
    assert.equal(result.status, 0, `bench failed: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.backend, 'sqlite');
    assert.deepEqual(report.sizes, [1, 2]);
    assert.equal(report.writesPerChild, 2);

    // Raw store contention leg, reused from the contention bench.
    assert.ok(Array.isArray(report.contention.perN));
    assert.equal(report.contention.perN.length, 2);

    // Kernel learn+query leg: p50/p95/p99, busy counters, queue lag.
    assert.ok(Array.isArray(report.learn.perN));
    assert.equal(report.learn.perN.length, 2);
    for (const leg of report.learn.perN) {
      for (const field of ['p50Ms', 'p95Ms', 'p99Ms']) {
        assert.equal(typeof leg[field], 'number', `${field} missing`);
      }
      assert.equal(typeof leg.sqliteBusyFailures, 'number');
      assert.equal(typeof leg.queueLagMs, 'number');
      assert.equal(typeof leg.maxEventLoopBlockMs, 'number');
    }

    // Open/RSS, WAL sidecars, cold restart split.
    for (const field of ['beforeBytes', 'afterOpenBytes', 'afterWritesBytes', 'slopeBytesPerWrite']) {
      assert.equal(typeof report.open.rss[field], 'number', `open.rss.${field} missing`);
    }
    for (const field of ['dbBytes', 'walBytes', 'shmBytes']) {
      assert.equal(typeof report.wal[field], 'number', `wal.${field} missing`);
    }
    for (const field of ['warmQueryMs', 'reopenOpenMs', 'coldQueryMs']) {
      assert.equal(typeof report.restart[field], 'number', `restart.${field} missing`);
    }

    // slo is present but never asserted for pass/fail (measured-only).
    assert.equal(typeof report.slo, 'object');
    assert.equal(report.slo.enforced, false);
  });

  it('module exposes parseSizes and walSizes', () => {
    const { parseSizes, walSizes } = require('./bench-capacity-envelope');
    assert.strictEqual(typeof parseSizes, 'function');
    assert.strictEqual(typeof walSizes, 'function');
  });
});
