#!/usr/bin/env node
// Compares the Rust bridge (rustGraph.js -> huqan-core) against the pure-JS
// Graph fallback for typical graph operations, so the "hızlandırıcı" claim
// is measured rather than assumed. Run with: node benchmarks/rust-vs-js-graph.js [nodeCount]
'use strict';

const path = require('path');
const fs = require('fs');
const Graph = require('../graph');
const RustGraph = require('../rustGraph');

const N = Number(process.argv[2]) || 2000;

async function benchRust(n) {
  const tmpMem = path.join(__dirname, `.bench-rust-${Date.now()}.json`);
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
  try { fs.rmSync(tmpMem, { force: true }); } catch {}
  return { ms: Number(t1 - t0) / 1e6, usingFallback };
}

async function benchRustBatch(n) {
  const tmpMem = path.join(__dirname, `.bench-rust-batch-${Date.now()}.json`);
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
  try { fs.rmSync(tmpMem, { force: true }); } catch {}
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

(async () => {
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

  console.log('\nTakeaway: per-command IPC round trips make the Rust bridge slower than the\n' +
    'in-process JS graph for typical sizes — the process-spawn + stdin/stdout\n' +
    'overhead dominates. Batching commands (cmd: "batch") amortizes that\n' +
    'overhead and is the only path where the Rust engine is worth using.');
})();
