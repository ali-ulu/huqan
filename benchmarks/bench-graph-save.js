'use strict';

// #3011: save() used to rewrite every node and edge row on every call, so the
// cost of a save -- and the event-loop hold it imposes -- scaled with the graph
// size. Since the delta tracking landed, a save after a mutation writes only
// the records that mutation touched; a full checkpoint is still taken on the
// first save, after a load(), and when the pending delta crosses a threshold.
//
// This benchmark measures the gap at the scale the issue names (10k nodes /
// 10k edges) and reports both the wall-clock saving and the row-write
// reduction, so the claim is not carried by a single noisy timing sample. It
// deliberately measures the FULL benchmark (no --quick shortcut) so the pinned
// threshold in check-graph-save.js is calibrated against the real save path,
// not a shortened one.
//
// Both numbers are measured on the same graph: the graph is checkpointed once,
// then a single node is added and saved (incremental), then load() puts the
// graph back into the "next save is a full checkpoint" state and that save is
// timed. load() itself is outside the timer, so the checkpoint number is the
// rewrite cost, not the read cost.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');

const VERSION = '1.0.0';
const WARMUP_ITERATIONS = 2;
const DEFAULT_FIXTURES = [
  { name: 'n-1000', nodes: 1000 },
  { name: 'n-10000', nodes: 10000 },
];

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

// Warmup calls are outside the returned samples, exactly as bench-memory-scale
// and bench-label-lookup do: the first run absorbs JIT setup and would
// otherwise flatter or penalise the metric.
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

// Counts the rows a save physically writes. This is the write amplification the
// issue is about, and it is measured rather than inferred: whatever statement a
// row goes through, it is counted. The wrapper installs once per graph and the
// returned `reset()`/`read()` pair lets one graph be counted across several
// saves without stacking wrappers.
function installRowCounter(graph) {
  const counts = { nodes: 0, edges: 0 };
  const originalPrepare = graph._db.prepare.bind(graph._db);
  graph._db.prepare = (sql) => {
    if (/INSERT INTO nodes/i.test(sql)) counts.nodes += 1;
    return originalPrepare(sql);
  };
  const originalEdgeRun = graph._stmts.upsertEdge.run.bind(graph._stmts.upsertEdge);
  graph._stmts.upsertEdge = {
    ...graph._stmts.upsertEdge,
    run: (...args) => { counts.edges += 1; return originalEdgeRun(...args); },
  };
  return {
    reset() { counts.nodes = 0; counts.edges = 0; },
    read() { return { nodes: counts.nodes, edges: counts.edges }; },
  };
}

function buildGraph(size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-bench-graph-save-'));
  benchmarkDirs.add(dir);
  const graph = new Graph({
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
    useSQLite: true,
  });
  for (let i = 0; i < size; i += 1) graph.addNode(`n${i}`, `Node ${i}`);
  for (let i = 0; i < size; i += 1) {
    graph.addEdge(`n${i}`, `n${(i + 1) % size}`, 'relates', { weight: 0.5 });
  }
  return { graph, dir };
}

function closeGraph(graph, dir) {
  try { graph?.close(); } catch (_) { /* the benchmark reports the metric, not the close */ }
  if (dir) {
    benchmarkDirs.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function benchSize(name, size, options = {}) {
  const iterations = options.iterations || 5;
  const { graph, dir } = buildGraph(size);
  try {
    if (graph.getStats().backend !== 'sqlite') {
      throw new Error('bench-graph-save requires the SQLite backend (better-sqlite3)');
    }

    // The first save is the full checkpoint this fixture starts from.
    graph.save();

    const counter = installRowCounter(graph);

    const incrementalMs = measure((i) => {
      graph.addNode(`probe-${i}`, `Probe ${i}`);
      graph.save();
    }, iterations);

    // A load() replaces the whole in-memory graph and forces the next save to a
    // full checkpoint. load() runs before the timer so the sample is the
    // rewrite, not the read.
    const checkpointMs = measure(() => {
      graph.load();
      graph.save();
    }, iterations);

    // Row writes for one incremental save and for one full checkpoint, counted
    // from the same wrapper so the reported reduction is a measured fact.
    counter.reset();
    graph.addNode('counted', 'Counted');
    graph.save();
    const incremental = counter.read();
    const incrementalRows = incremental.nodes + incremental.edges;

    counter.reset();
    graph.load();
    graph.save();
    const checkpoint = counter.read();
    const checkpointRows = checkpoint.nodes + checkpoint.edges;

    // The fixture shape is the declared size, not the post-probe row count:
    // the probe adds a handful of rows during the timed loop, and a regression
    // threshold must compare like for like across runs.
    return {
      name,
      nodes: size,
      edges: size,
      iterations,
      warmupIterations: WARMUP_ITERATIONS,
      checkpointMs,
      incrementalMs,
      checkpointRows,
      incrementalRows,
      // Only meaningful when the reduction is real; callers assert it is.
      writeRatio: incrementalMs > 0 ? Number((checkpointMs / incrementalMs).toFixed(2)) : null,
      rowReduction: incrementalRows > 0 ? Number((checkpointRows / incrementalRows).toFixed(2)) : null,
    };
  } finally {
    closeGraph(graph, dir);
  }
}

function runBenchmarks(options = {}) {
  const fixtures = options.fixtures || DEFAULT_FIXTURES;
  const iterations = options.iterations || 5;
  const results = fixtures.map((fixture) => benchSize(fixture.name, fixture.nodes, { iterations }));
  return {
    version: VERSION,
    iterations,
    warmupIterations: WARMUP_ITERATIONS,
    fixtures: Object.fromEntries(results.map((result) => [result.name, result])),
  };
}

function printHuman(result) {
  console.log('HUQAN graph incremental-save benchmark (#3011)');
  console.log(`version=${result.version} iterations=${result.iterations} warmupIterations=${result.warmupIterations}`);
  for (const [, data] of Object.entries(result.fixtures)) {
    console.log('');
    console.log(`[${data.name}] nodes=${data.nodes} edges=${data.edges}`);
    console.log(`  checkpoint  ${data.checkpointMs}ms  rows=${data.checkpointRows}`);
    console.log(`  incremental ${data.incrementalMs}ms  rows=${data.incrementalRows}`);
    console.log(`  speedup=${data.writeRatio}x  rowReduction=${data.rowReduction}x`);
  }
  console.log('\ncheckpoint = a full save (first save / after load / threshold); incremental = one mutated node.');
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const iterationsArg = process.argv.find((arg) => arg.startsWith('--iterations='));
  const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : (args.has('--quick') ? 2 : 5);
  const fixturesArg = process.argv.find((arg) => arg.startsWith('--fixtures='));
  const fixtures = fixturesArg
    ? fixturesArg.split('=')[1].split(',').filter(Boolean).map((name) => {
      const match = /^n-(\d+)$/.exec(name);
      if (!match) throw new Error(`Unknown fixture: ${name} (expected n-<count>)`);
      return { name, nodes: Number(match[1]) };
    })
    : (args.has('--quick') ? [DEFAULT_FIXTURES[0]] : undefined);
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
  installRowCounter,
  DEFAULT_FIXTURES,
  WARMUP_ITERATIONS,
  VERSION,
};
