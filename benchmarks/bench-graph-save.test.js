'use strict';

// Smoke + contract tests for the #3011 incremental-save benchmark and its
// regression gate. The benchmark test runs one small fixture; the gate test
// exercises the pure ratio logic with synthetic numbers so the threshold itself
// is covered without paying benchmark cost.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  runBenchmarks,
  buildGraph,
  installRowCounter,
  DEFAULT_FIXTURES,
  WARMUP_ITERATIONS,
} = require('./bench-graph-save');
const {
  evaluateGraphSaveRegression,
  DEFAULT_MIN_ROW_REDUCTION,
  DEFAULT_MIN_SPEEDUP,
  MAX_INCREMENTAL_ROWS,
} = require('./check-graph-save');
const fs = require('node:fs');

describe('bench-graph-save (#3011)', () => {
  it('buildGraph creates the declared node and edge counts', () => {
    const { graph, dir } = buildGraph(120);
    try {
      const stats = graph.getStats();
      assert.equal(stats.nodes, 120);
      assert.equal(stats.edges, 120);
    } finally {
      graph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one mutation writes a bounded number of rows, far below a checkpoint', () => {
    const { graph, dir } = buildGraph(200);
    try {
      if (graph.getStats().backend !== 'sqlite') return; // better-sqlite3 unavailable
      const counter = installRowCounter(graph);
      graph.save();

      counter.reset();
      graph.addNode('delta', 'Delta');
      graph.save();
      const incrementalRows = counter.read().nodes + counter.read().edges;

      counter.reset();
      graph.load();
      graph.save();
      const checkpointRows = counter.read().nodes + counter.read().edges;

      assert.ok(incrementalRows <= MAX_INCREMENTAL_ROWS, `incremental wrote ${incrementalRows} rows`);
      // At 200 nodes a checkpoint writes ~2 rows per node (node + edge). The
      // 1000x floor is calibrated for the 10k fixture (check-graph-save), so
      // this smoke only asserts the structural claim: the checkpoint rewrites
      // the whole small graph while the delta writes almost nothing.
      assert.ok(
        checkpointRows >= 200,
        `checkpoint must rewrite the whole small graph (got ${checkpointRows} rows)`,
      );
    } finally {
      graph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runBenchmarks reports the fixture shape and non-negative timings', () => {
    const result = runBenchmarks({ fixtures: [{ name: 'n-200', nodes: 200 }], iterations: 1 });
    assert.equal(result.warmupIterations, WARMUP_ITERATIONS);
    const fixture = result.fixtures['n-200'];
    assert.equal(fixture.nodes, 200);
    assert.equal(fixture.edges, 200);
    assert.ok(fixture.checkpointMs >= 0);
    assert.ok(fixture.incrementalMs >= 0);
    assert.ok(fixture.incrementalRows >= 1);
    assert.ok(fixture.checkpointRows > fixture.incrementalRows);
  });

  it('exposes the 10k fixture the issue is about', () => {
    const names = DEFAULT_FIXTURES.map((fixture) => fixture.name);
    assert.ok(names.includes('n-10000'), 'the 10k scale must be a default fixture');
    for (const fixture of DEFAULT_FIXTURES) {
      assert.equal(fixture.name, `n-${fixture.nodes}`);
    }
  });
});

describe('check-graph-save (#3011)', () => {
  function currentFixture(overrides = {}) {
    return {
      name: 'n-10000',
      nodes: 10000,
      edges: 10000,
      checkpointMs: 440,
      incrementalMs: 43,
      checkpointRows: 20006,
      incrementalRows: 1,
      writeRatio: 10,
      rowReduction: 20006,
      ...overrides,
    };
  }
  function baseline() {
    const base = currentFixture();
    return {
      version: '1.0.0',
      fixtures: {
        'n-10000': {
          nodes: base.nodes,
          edges: base.edges,
          checkpointRows: base.checkpointRows,
          incrementalRows: base.incrementalRows,
          incrementalMs: base.incrementalMs,
        },
      },
    };
  }

  it('passes when the delta stays bounded and the ratios hold', () => {
    const result = evaluateGraphSaveRegression(baseline(), { fixtures: { 'n-10000': currentFixture() } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.blockingFailures, []);
  });

  it('fails when the incremental path rewrites unrelated rows', () => {
    const result = evaluateGraphSaveRegression(baseline(), {
      fixtures: { 'n-10000': currentFixture({ incrementalRows: 500, rowReduction: 40 }) },
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockingFailures.some((failure) => /rowReduction/.test(failure)));
  });

  it('fails when a mutation writes more than the bounded row count', () => {
    const result = evaluateGraphSaveRegression(baseline(), {
      fixtures: { 'n-10000': currentFixture({ incrementalRows: 3 }) },
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockingFailures.some((failure) => /delta is not bounded/.test(failure)));
  });

  it('treats the speedup floor as advisory by default and blocking under strict timing', () => {
    const slow = currentFixture({ writeRatio: DEFAULT_MIN_SPEEDUP - 1 });
    const current = { fixtures: { 'n-10000': slow } };
    const advisory = evaluateGraphSaveRegression(baseline(), current);
    assert.equal(advisory.ok, true);
    assert.ok(advisory.advisoryFailures.some((failure) => /faster than a checkpoint/.test(failure)));

    const strict = evaluateGraphSaveRegression(baseline(), current, { strictTiming: true });
    assert.equal(strict.ok, false);
  });

  it('reports a missing fixture as a blocking failure', () => {
    const result = evaluateGraphSaveRegression(baseline(), { fixtures: {} });
    assert.equal(result.ok, false);
    assert.ok(result.blockingFailures.some((failure) => /Missing benchmark fixture/.test(failure)));
  });

  it('exposes documented default floors', () => {
    assert.equal(DEFAULT_MIN_ROW_REDUCTION, 1000);
    assert.equal(DEFAULT_MIN_SPEEDUP, 3);
    assert.equal(MAX_INCREMENTAL_ROWS, 2);
  });
});
