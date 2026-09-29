'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  runBenchmarks,
  benchSize,
  buildGraph,
  scanLabelLookup,
  scanWorkspaceCount,
  DEFAULT_FIXTURES,
  WARMUP_ITERATIONS,
} = require('./bench-label-lookup');

const fs = require('node:fs');

describe('bench-label-lookup (#3009)', () => {
  it('the scan reference matches the indexed query on the same node map', () => {
    const { graph, dir } = buildGraph(512, 64, 4);
    try {
      const label = 'label-7';
      const workspaceId = 'ws-3';
      const indexed = graph.query(label, workspaceId).map(node => node.id).sort();
      const scanned = scanLabelLookup(graph._nodes, label, workspaceId).map(node => node.id).sort();
      assert.ok(indexed.length > 0, 'probe must match nodes');
      assert.deepEqual(indexed, scanned, 'index and scan must agree exactly');
    } finally {
      graph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the scan count reference matches the indexed workspace count', () => {
    const { graph, dir } = buildGraph(512, 64, 4);
    try {
      assert.equal(graph.nodeCount('ws-3'), scanWorkspaceCount(graph._nodes, 'ws-3'));
      assert.equal(graph.nodeCount('default'), scanWorkspaceCount(graph._nodes, 'default'));
    } finally {
      graph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildGraph places every node exactly once', () => {
    const { graph, dir } = buildGraph(300, 64, 4);
    try {
      assert.equal(graph.nodeCount(), 300);
      const total = ['default', 'ws-1', 'ws-2', 'ws-3']
        .reduce((sum, ws) => sum + graph.nodeCount(ws), 0);
      assert.equal(total, 300);
    } finally {
      graph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runBenchmarks reports the fixture shape and non-negative timings', () => {
    const result = runBenchmarks({ fixtures: [{ name: 'n-500', nodes: 500 }], iterations: 1 });
    assert.equal(result.warmupIterations, WARMUP_ITERATIONS);
    const fixture = result.fixtures['n-500'];
    assert.equal(fixture.nodes, 500);
    assert.ok(fixture.indexedQueryMs >= 0);
    assert.ok(fixture.scanQueryMs >= 0);
    assert.equal(fixture.indexHits, fixture.scanHits);
    assert.ok(fixture.probeSpeedup >= 1, 'index must not be slower than the scan it replaces');
  });

  it('exposes documented default fixtures', () => {
    assert.ok(DEFAULT_FIXTURES.length >= 1);
    for (const fixture of DEFAULT_FIXTURES) {
      assert.match(fixture.name, /^n-\d+$/);
      assert.equal(fixture.name, `n-${fixture.nodes}`);
    }
  });
});
