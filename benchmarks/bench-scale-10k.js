'use strict';

// #3016: the largest end-to-end benchmark fixture was `xlarge` (140 nodes /
// 131 edges), so there was no measured evidence for the 10k-100k range on the
// primary product paths. The read-micro benchmark (bench-label-lookup.js) and
// the save benchmark (bench-graph-save.js) already cover n-10000 on their own
// paths; this file closes the remaining gap with one end-to-end pass at 10k
// nodes across seed (write), ask, verify, reason (read) and save (write),
// reporting latency, throughput, and heap alongside the numbers.
//
// Two deliberately separated write paths, because they scale differently
// (measured 2026-09-29, see docs/scale-truth-pack.md):
// - Graph bulk seed (`graph.addNode`/`addEdge`) is linear: 10k nodes in
//   ~50ms, 10k edges in ~100ms. The 10k read/save numbers below are measured
//   on a graph seeded this way.
// - `kernel.learn` admission is superlinear (~60ms/learn at n=50 rising to
//   ~250ms/learn at n=300 on the same machine), so a 10k learn batch does not
//   finish in a benchmark budget. Admission scale is measured separately by
//   the learn curve at small sizes, and the scale document bounds the claim
//   instead of extending it.
//
// Default fixture is exactly one size (scale-10k). scale-100k is opt-in via
// --fixtures=scale-100k because it takes minutes and must never run in the
// default path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const Graph = require('../graph');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

const VERSION = '1.0.0';
const WARMUP_ITERATIONS = 1;
const DEFAULT_FIXTURES = [
  { name: 'scale-10k', nodes: 10000 },
];
const KNOWN_FIXTURES = {
  'scale-10k': 10000,
  'scale-100k': 100000,
};
const DEFAULT_LEARN_SIZES = [100, 200, 400];
const QUICK_LEARN_SIZES = [50, 100];

const benchmarkDirs = new Set();

process.once('exit', () => {
  for (const dir of benchmarkDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function hrMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function heapUsedMB() {
  return Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
}

// Warmup calls are outside the returned samples, exactly as bench-memory-scale,
// bench-label-lookup and bench-graph-save do.
function measure(fn, iterations) {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) fn(i, 'warmup');
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    fn(i, 'measured');
    samples.push(hrMs(start));
  }
  return Number(average(samples).toFixed(3));
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  benchmarkDirs.add(dir);
  return dir;
}

function closeDir(dir) {
  if (dir) {
    benchmarkDirs.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createKernel() {
  const dir = tempDir('huqan-bench-scale-');
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(dir, 'memory.json'),
  });
  kernel.__benchmarkPersistenceDir = dir;
  return kernel;
}

function closeKernel(kernel) {
  const dir = kernel?.__benchmarkPersistenceDir;
  try {
    if (typeof kernel?.graph?.close === 'function') kernel.graph.close();
  } finally {
    if (dir) closeDir(dir);
  }
}

// Bulk seed through the Graph API. This is the write path the 10k read/save
// numbers stand on; admission (`kernel.learn`) is measured by benchLearnCurve
// instead because it does not finish at this scale.
function seedGraph(kernel, size) {
  for (let i = 0; i < size; i += 1) kernel.graph.addNode(`olcek-${i}`, `Olcek ${i}`);
  for (let i = 0; i < size; i += 1) {
    kernel.graph.addEdge(`olcek-${i}`, `olcek-${(i + 1) % size}`, 'relates', { weight: 0.5 });
  }
}

// Admission cost at small sizes, one fresh kernel per size so every batch
// pays the full cold-start-to-N cost. No warmup here: the curve IS the
// measurement, and a warmup batch would double the two larger sizes.
function benchLearnCurve(sizes) {
  return sizes.map((size) => {
    const start = process.hrtime.bigint();
    const kernel = createKernel();
    try {
      for (let i = 0; i < size; i += 1) {
        kernel.learn(`olcek-${i} kavramdir`, TEST_FIXTURE_LEARN_BYPASS);
      }
    } finally {
      closeKernel(kernel);
    }
    const batchMs = Number((Number(process.hrtime.bigint() - start) / 1e6).toFixed(3));
    return { size, batchMs, perNodeMs: Number((batchMs / size).toFixed(3)) };
  });
}

// A full SQLite checkpoint at the same scale, timed on a dedicated Graph so
// the save number is the rewrite cost, not the seed cost. Row amplification
// is pinned by bench-graph-save.js (#3011); here only wall-clock matters.
function benchSave(size, iterations) {
  const dir = tempDir('huqan-bench-scale-save-');
  const graph = new Graph({
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
    useSQLite: true,
  });
  try {
    if (graph.getStats().backend !== 'sqlite') {
      throw new Error('bench-scale-10k save path requires the SQLite backend (better-sqlite3)');
    }
    for (let i = 0; i < size; i += 1) graph.addNode(`olcek-${i}`, `Olcek ${i}`);
    for (let i = 0; i < size; i += 1) {
      graph.addEdge(`olcek-${i}`, `olcek-${(i + 1) % size}`, 'relates', { weight: 0.5 });
    }
    return measure(() => {
      graph.load();
      graph.save();
    }, iterations);
  } finally {
    try { graph?.close(); } catch (_) { /* the benchmark reports the metric, not the close */ }
    closeDir(dir);
  }
}

function benchSize(name, size, options = {}) {
  const iterations = options.iterations || 3;
  const learnSizes = options.learnSizes || DEFAULT_LEARN_SIZES;
  const heapBeforeMB = heapUsedMB();

  const queryKernel = createKernel();
  try {
    const seedStart = process.hrtime.bigint();
    seedGraph(queryKernel, size);
    const seedMs = Number((Number(process.hrtime.bigint() - seedStart) / 1e6).toFixed(3));
    const heapAfterSeedMB = heapUsedMB();

    const subject = 'olcek-0';
    const askMs = measure(() => queryKernel.ask(`${subject} nedir`), iterations);
    const verifyMs = measure(() => queryKernel.verify(`${subject} kavramdir`), iterations);
    const reasonMs = measure(() => queryKernel.reason(subject), iterations);
    const stats = queryKernel.graph.getStats();

    const saveMs = benchSave(size, iterations);
    const learnCurve = benchLearnCurve(learnSizes);

    return {
      name,
      nodes: stats.nodes,
      edges: stats.edges,
      declaredNodes: size,
      iterations,
      warmupIterations: WARMUP_ITERATIONS,
      seedMs,
      seedThroughputNodesPerSec: seedMs > 0 ? Math.round((size / seedMs) * 1000) : null,
      askMs,
      verifyMs,
      reasonMs,
      saveMs,
      learnCurve,
      heapBeforeMB,
      heapAfterSeedMB,
      heapDeltaMB: Number((heapAfterSeedMB - heapBeforeMB).toFixed(2)),
    };
  } finally {
    closeKernel(queryKernel);
  }
}

function runBenchmarks(options = {}) {
  const fixtures = options.fixtures || DEFAULT_FIXTURES;
  const iterations = options.iterations || 3;
  const learnSizes = options.learnSizes;
  const results = fixtures.map((fixture) => benchSize(fixture.name, fixture.nodes, { iterations, learnSizes }));
  return {
    version: VERSION,
    iterations,
    warmupIterations: WARMUP_ITERATIONS,
    fixtures: Object.fromEntries(results.map((result) => [result.name, result])),
  };
}

function printHuman(result) {
  console.log('HUQAN end-to-end scale benchmark (#3016)');
  console.log(`version=${result.version} iterations=${result.iterations} warmupIterations=${result.warmupIterations}`);
  for (const [, data] of Object.entries(result.fixtures)) {
    console.log('');
    console.log(`[${data.name}] nodes=${data.nodes} edges=${data.edges}`);
    console.log(`  seed    ${data.seedMs}ms  throughput=${data.seedThroughputNodesPerSec} nodes/s (graph bulk write)`);
    console.log(`  ask     ${data.askMs}ms`);
    console.log(`  verify  ${data.verifyMs}ms`);
    console.log(`  reason  ${data.reasonMs}ms`);
    console.log(`  save    ${data.saveMs}ms  (full SQLite checkpoint)`);
    console.log('  learn curve (kernel.learn batch, fresh kernel per size):');
    for (const point of data.learnCurve) {
      console.log(`    n=${point.size} batch=${point.batchMs}ms per-node=${point.perNodeMs}ms`);
    }
    console.log(`  heap    before=${data.heapBeforeMB}MB after-seed=${data.heapAfterSeedMB}MB delta=${data.heapDeltaMB}MB`);
  }
  console.log('\nShape (nodes/edges) is the blocking contract; timings and heap are advisory across machines.');
}

function parseArgs(argv) {
  const args = new Set(argv);
  const iterationsArg = argv.find((arg) => arg.startsWith('--iterations='));
  const iterations = iterationsArg
    ? Number(iterationsArg.split('=')[1])
    : (args.has('--quick') ? 1 : 3);
  const fixturesArg = argv.find((arg) => arg.startsWith('--fixtures='));
  const fixtures = fixturesArg
    ? fixturesArg.split('=')[1].split(',').filter(Boolean).map((fixtureName) => {
      const match = /^scale-(\d+k)$/.exec(fixtureName);
      const nodes = KNOWN_FIXTURES[fixtureName]
        ?? (match ? Number(match[1].replace('k', '000')) : NaN);
      if (!Number.isFinite(nodes) || nodes <= 0) {
        throw new Error(`Unknown fixture: ${fixtureName} (expected scale-10k or scale-100k)`);
      }
      return { name: fixtureName, nodes };
    })
    : (args.has('--quick') ? [DEFAULT_FIXTURES[0]] : undefined);
  const learnSizes = args.has('--quick') ? QUICK_LEARN_SIZES : undefined;
  return { args, iterations, fixtures, learnSizes };
}

if (require.main === module) {
  const { args, iterations, fixtures, learnSizes } = parseArgs(process.argv.slice(2));
  const result = runBenchmarks({ fixtures, iterations, learnSizes });
  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }
}

module.exports = {
  runBenchmarks,
  benchSize,
  benchLearnCurve,
  seedGraph,
  parseArgs,
  DEFAULT_FIXTURES,
  KNOWN_FIXTURES,
  WARMUP_ITERATIONS,
  VERSION,
};
