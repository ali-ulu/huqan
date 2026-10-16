'use strict';

// #3009: label lookup used to be `Object.values(nodes).filter(node =>
// node.label === label && workspace matches)` -- O(N) in the whole node map.
// The label index answers the same question in O(bucket size), and a scoped
// node count in O(1).
//
// This benchmark measures that gap directly on a deterministic fixture: the
// index-backed Graph query is timed against a scan that reproduces the old
// implementation on the exact same node map. Reporting both makes the speedup
// self-evident instead of asserting a constant.
//
// Fixture sizes are documented in docs/scale-truth-pack.md; the defaults here
// are deliberately larger than the shape fixtures because the O(N)-vs-O(1)
// difference only becomes visible once N is in the thousands.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');
const { normalizeWorkspaceId } = require('../lib/graph-record-utils');

const VERSION = '1.0.0';
const WARMUP_ITERATIONS = 2;
const DEFAULT_LABELS = 64;
const DEFAULT_WORKSPACES = 4;
const DEFAULT_FIXTURES = [
  { name: 'n-1000', nodes: 1000 },
  { name: 'n-10000', nodes: 10000 },
];

function hrMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Warmup calls are outside the returned samples: the first run absorbs JIT
// setup and would otherwise distort the metric, exactly as bench-memory-scale
// does.
function measure(name, fn, iterations) {
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn(i, 'warmup');
  const samples = [];
  let last;
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    last = fn(i, 'measured');
    samples.push(hrMs(start));
  }
  return {
    name,
    iterations,
    warmupIterations: WARMUP_ITERATIONS,
    avgMs: Number(average(samples).toFixed(3)),
    last,
  };
}

// The pre-#3009 implementation, kept verbatim so the comparison is honest: any
// drift from it would flatter the index.
function scanLabelLookup(nodes, label, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  return Object.values(nodes)
    .filter(node => node.label === label && normalizeWorkspaceId(node.workspaceId) === scope);
}

function scanWorkspaceCount(nodes, workspaceId = 'default') {
  const scope = normalizeWorkspaceId(workspaceId);
  return Object.values(nodes).filter(node => normalizeWorkspaceId(node.workspaceId) === scope).length;
}

function buildGraph(size, labels, workspaces) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-bench-label-'));
  const graph = new Graph({ noLoad: true, useSQLite: false, persistenceDir: dir });
  for (let i = 0; i < size; i++) {
    const label = `label-${i % labels}`;
    const workspaceId = i % workspaces === 0 ? 'default' : `ws-${i % workspaces}`;
    graph.addNode(`n${i}`, label, null, { workspaceId });
  }
  return { graph, dir };
}

function benchSize(name, size, opts) {
  const options = opts || {};
  const labels = options.labels || DEFAULT_LABELS;
  const workspaces = options.workspaces || DEFAULT_WORKSPACES;
  const iterations = options.iterations || 5;
  const probes = options.probes || 1000;
  const { graph, dir } = buildGraph(size, labels, workspaces);
  try {
    const nodes = graph._nodes;
    const label = 'label-7';
    // size = 1000/10000 are multiples of labels*workspaces (256), so the nodes
    // carrying `label-7` all land in the same workspace bucket: i % labels === 7
    // implies i % workspaces === 3, i.e. `ws-3`. Probing that bucket keeps the
    // hits non-zero so the scan actually filters, not just iterates.
    const workspaceId = `ws-${7 % workspaces}`;
    const scanHits = scanLabelLookup(nodes, label, workspaceId).length;
    const indexHits = graph.query(label, workspaceId).length;
    if (scanHits === 0) throw new Error('benchmark probe must match nodes, otherwise the scan is not filtered');

    const indexed = measure(`${name}:indexedQuery`, () => graph.query(label, workspaceId), iterations);
    const scan = measure(`${name}:scanQuery`, () => scanLabelLookup(nodes, label, workspaceId), iterations);
    const indexedCount = measure(`${name}:indexedCount`, () => graph.nodeCount(workspaceId), iterations);
    const scanCount = measure(`${name}:scanCount`, () => scanWorkspaceCount(nodes, workspaceId), iterations);

    // A single query is sub-millisecond at small N, so wall-clock noise
    // dominates. `probes` repeats magnify the difference without changing it.
    const indexedProbe = measure(`${name}:indexedQueryX${probes}`,
      () => { let n = 0; for (let i = 0; i < probes; i++) n += graph.query(label, workspaceId).length; return n; },
      iterations);
    const scanProbe = measure(`${name}:scanQueryX${probes}`,
      () => { let n = 0; for (let i = 0; i < probes; i++) n += scanLabelLookup(nodes, label, workspaceId).length; return n; },
      iterations);

    return {
      name,
      nodes: graph.nodeCount(),
      labels,
      workspaces,
      iterations,
      warmupIterations: WARMUP_ITERATIONS,
      probes,
      scanHits,
      indexHits,
      indexedQueryMs: indexed.avgMs,
      scanQueryMs: scan.avgMs,
      indexedCountMs: indexedCount.avgMs,
      scanCountMs: scanCount.avgMs,
      indexedProbeMs: indexedProbe.avgMs,
      scanProbeMs: scanProbe.avgMs,
      querySpeedup: scan.avgMs > 0 ? Number((scan.avgMs / Math.max(indexed.avgMs, 1e-6)).toFixed(2)) : null,
      probeSpeedup: Number((scanProbe.avgMs / Math.max(indexedProbe.avgMs, 1e-6)).toFixed(2)),
      countSpeedup: scanCount.avgMs > 0 ? Number((scanCount.avgMs / Math.max(indexedCount.avgMs, 1e-6)).toFixed(2)) : null,
    };
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runBenchmarks(opts) {
  const options = opts || {};
  const fixtures = options.fixtures || DEFAULT_FIXTURES;
  const results = fixtures.map(fixture => benchSize(fixture.name, fixture.nodes, options));
  return {
    version: VERSION,
    iterations: options.iterations || 5,
    warmupIterations: WARMUP_ITERATIONS,
    fixtures: Object.fromEntries(results.map(result => [result.name, result])),
  };
}

function printHuman(result) {
  console.log('AXIOM graph label-lookup benchmark (#3009)');
  console.log(`version=${result.version} iterations=${result.iterations} warmupIterations=${result.warmupIterations}`);
  for (const [, data] of Object.entries(result.fixtures)) {
    console.log('');
    console.log(`[${data.name}] nodes=${data.nodes} labels=${data.labels} workspaces=${data.workspaces}`);
    console.log(`  single query   indexed=${data.indexedQueryMs}ms scan=${data.scanQueryMs}ms speedup=${data.querySpeedup}x`);
    console.log(`  ${data.probes} queries indexed=${data.indexedProbeMs}ms scan=${data.scanProbeMs}ms speedup=${data.probeSpeedup}x`);
    console.log(`  scoped count   indexed=${data.indexedCountMs}ms scan=${data.scanCountMs}ms speedup=${data.countSpeedup}x`);
    console.log(`  hits           indexed=${data.indexHits} scan=${data.scanHits}`);
  }
  console.log('\nscan = the pre-#3009 Object.values(nodes).filter(...) implementation.');
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const iterationsArg = process.argv.find(arg => arg.startsWith('--iterations='));
  const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : (args.has('--quick') ? 2 : 5);
  const fixturesArg = process.argv.find(arg => arg.startsWith('--fixtures='));
  const fixtures = fixturesArg
    ? fixturesArg.split('=')[1].split(',').filter(Boolean).map(name => {
      const match = /^n-(\d+)$/.exec(name);
      if (!match) throw new Error(`Unknown fixture: ${name} (expected n-<count>)`);
      return { name, nodes: Number(match[1]) };
    })
    : undefined;
  const result = runBenchmarks({ fixtures, iterations });
  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }
}

module.exports = {
  runBenchmarks,
  benchSize,
  buildGraph,
  scanLabelLookup,
  scanWorkspaceCount,
  DEFAULT_FIXTURES,
  WARMUP_ITERATIONS,
  VERSION,
};
