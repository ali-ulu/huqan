#!/usr/bin/env node
// Compares the Rust bridge (rustGraph.js -> huqan-core) against the pure-JS
// Graph fallback for typical graph operations, so the "hızlandırıcı" claim
// is measured rather than assumed. Run with: node benchmarks/rust-vs-js-graph.js [nodeCount]
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Graph = require('../graph');
const Kernel = require('../kernel');
const RustGraph = require('../rustGraph');

const LEARN_BYPASS = Kernel.createAdmissionBypassOpts('rust_learn_benchmark');
const N = Number(process.argv[2]) || 2000;

function learnStatements(n) {
  return Array.from({ length: n }, (_, i) => `node${i} hayvandir`);
}

function createRustBenchmarkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, memoryPath: path.join(dir, 'memory.json') };
}

function removeRustBenchmarkTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function benchRust(n) {
  const temp = createRustBenchmarkTemp('huqan-rust-bench-');
  const tmpMem = temp.memoryPath;
  const g = new RustGraph(tmpMem);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    await g.addNode(`n${i}`, `label${i}`);
  }
  for (let i = 0; i < n - 1; i++) {
    await g.addEdge(`n${i}`, `n${i + 1}`, 'tür');
  }
  for (let i = 0; i < n; i++) {
    await g.getEdges(`n${i}`);
  }
  const t1 = process.hrtime.bigint();
  const usingFallback = !!g._fallback;
  g.destroy();
  removeRustBenchmarkTemp(temp.dir);
  return { ms: Number(t1 - t0) / 1e6, usingFallback };
}

async function benchRustBatch(n) {
  const temp = createRustBenchmarkTemp('huqan-rust-batch-bench-');
  const tmpMem = temp.memoryPath;
  const g = new RustGraph(tmpMem);
  const t0 = process.hrtime.bigint();
  const addNodeCmds = [];
  for (let i = 0; i < n; i++) addNodeCmds.push({ cmd: 'add_node', id: `b${i}`, label: `label${i}` });
  await g._send({ cmd: 'batch', commands: addNodeCmds });
  const addEdgeCmds = [];
  for (let i = 0; i < n - 1; i++) addEdgeCmds.push({ cmd: 'add_edge', from: `b${i}`, to: `b${i + 1}`, relation: 'tür' });
  await g._send({ cmd: 'batch', commands: addEdgeCmds });
  const t1 = process.hrtime.bigint();
  const usingFallback = !!g._fallback;
  g.destroy();
  removeRustBenchmarkTemp(temp.dir);
  return { ms: Number(t1 - t0) / 1e6, usingFallback };
}

function benchJs(n) {
  const g = new Graph();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    g.addNode(`n${i}`, `label${i}`);
  }
  for (let i = 0; i < n - 1; i++) {
    g.addEdge(`n${i}`, `n${i + 1}`, 'tür');
  }
  for (let i = 0; i < n; i++) {
    g.getEdges(`n${i}`);
  }
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6 };
}

function benchJsLearn(n) {
  const g = new Kernel({ noLoad: true, loadPlugins: false, useSQLite: false });
  const statements = learnStatements(n);
  const t0 = process.hrtime.bigint();
  for (const statement of statements) g.learn(statement, LEARN_BYPASS);
  const t1 = process.hrtime.bigint();
  try { g.graph.close(); } catch {}
  return { ms: Number(t1 - t0) / 1e6 };
}

async function benchRustLearn(n) {
  const temp = createRustBenchmarkTemp('huqan-rust-learn-bench-');
  const tmpMem = temp.memoryPath;
  const g = new RustGraph(tmpMem);
  const t0 = process.hrtime.bigint();
  const result = await g.learnBatch(learnStatements(n));
  const t1 = process.hrtime.bigint();
  const usingFallback = !!g._fallback;
  g.destroy();
  removeRustBenchmarkTemp(temp.dir);
  return { ms: Number(t1 - t0) / 1e6, usingFallback, ok: result.ok };
}

(async () => {
  // rustGraph.js unrefs the child process while idle; keep this short-lived
  // benchmark alive while awaited IPC is in flight.
  const keepalive = setInterval(() => {}, 1000);
  console.log(`Graph benchmark: ${N} nodes, ${N - 1} edges, per-command round trips vs batched vs pure JS.\n`);

  const js = benchJs(N);
  console.log(`JS fallback (in-process):        ${js.ms.toFixed(1)} ms`);

  const rust = await benchRust(N);
  if (rust.usingFallback) {
    console.log('Rust binary not found — rustGraph.js fell back to JS Graph (build huqan-core first: cd huqan-core && cargo build --release).');
  } else {
    console.log(`Rust bridge (per-command IPC):   ${rust.ms.toFixed(1)} ms  (${(rust.ms / js.ms).toFixed(1)}x JS)`);
  }

  const rustBatch = await benchRustBatch(N);
  if (!rustBatch.usingFallback) {
    console.log(`Rust bridge (batched IPC):        ${rustBatch.ms.toFixed(1)} ms  (${(rustBatch.ms / js.ms).toFixed(1)}x JS)`);
  }

  const jsLearn = benchJsLearn(N);
  console.log(`Kernel.learn (canonical JS):      ${jsLearn.ms.toFixed(1)} ms`);
  const rustLearn = await benchRustLearn(N);
  if (!rustLearn.usingFallback && rustLearn.ok) {
    console.log(`Rust learnBatch (one IPC batch):  ${rustLearn.ms.toFixed(1)} ms  (${(rustLearn.ms / jsLearn.ms).toFixed(1)}x Kernel.learn)`);
  } else {
    console.log('Rust learnBatch unavailable — build huqan-core or set HUQAN_RUST_BIN; JS benchmark remains the fallback reference.');
  }

  console.log('\nTakeaway: per-command IPC round trips make the Rust bridge slower than the\n' +
    'in-process JS graph for typical sizes — the process-spawn + stdin/stdout\n' +
    'overhead dominates. The batched Rust learn path is an optional accelerator\n' +
    'surface; canonical Kernel.learn remains synchronous and admission-governed.');
  clearInterval(keepalive);
})();
