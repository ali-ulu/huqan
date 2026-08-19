'use strict';

/**
 * Request-scoped isolation for `Kernel#reasonSandbox` (#758).
 *
 * `huqan-core/src/main.rs` builds exactly one `Graph` before entering its stdin
 * loop and mutates it for the lifetime of the process; `batch` runs its child
 * commands against that same graph, so it is a batching primitive and never an
 * isolation boundary. Sending sandbox work to the kernel's long-lived RustGraph
 * therefore let facts learned by one `reasonSandbox()` call answer a later one.
 *
 * The isolation unit is the process, so each call gets its own RustGraph — its
 * own child process, and so its own `Graph` — which is destroyed before the
 * call returns. Two consequences are deliberate:
 *
 *   - the kernel's own RustGraph is never touched, so sandbox teardown cannot
 *     reset or damage a non-sandbox consumer;
 *   - concurrent calls hold distinct processes, so they cannot observe each
 *     other regardless of interleaving.
 *
 * The cost is one process spawn per call. That is the price of the contract
 * this method advertises ("ephemeral, isolated, never persisted"); callers that
 * want an accumulating graph should use the kernel's own learn/ask instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const RustGraph = require('../rustGraph');

let sandboxCounter = 0;

/**
 * A path that exists only so the RustGraph constructor has one. The sandbox
 * never issues save/load, and a sandbox that degrades into RustGraph's JS
 * fallback is abandoned (see below) rather than used, so nothing is written
 * here — but pointing it away from the kernel's real memory.json keeps that
 * true even if a future fallback path touches disk.
 */
function sandboxMemoryPath() {
  sandboxCounter += 1;
  return path.join(os.tmpdir(), `huqan-reason-sandbox-${process.pid}-${sandboxCounter}.json`);
}

function rustBinaryAvailable() {
  try {
    return fs.existsSync(RustGraph.resolveRustBin());
  } catch (_) {
    return false;
  }
}

function defaultCreateRustGraph(opts) {
  return new RustGraph(opts);
}

/**
 * Run one sandbox batch against a private huqan-core process.
 *
 * @param {object}   spec
 * @param {string[]} spec.learn            - facts visible only to this call.
 * @param {string[]} spec.ask              - questions answered from those facts.
 * @param {function} [spec.createRustGraph] - seam for tests; defaults to a real RustGraph.
 * @param {number}   [spec.requestTimeoutMs]
 * @returns {Promise<string[]|null>} answers, or null when the Rust backend is
 *   unusable (binary missing, spawn failed, process died mid-flight) and the
 *   caller should fall back to the JS sandbox.
 */
async function runRustSandbox(spec = {}) {
  const learn = Array.isArray(spec.learn) ? spec.learn : [];
  const ask = Array.isArray(spec.ask) ? spec.ask : [];
  const createRustGraph = typeof spec.createRustGraph === 'function'
    ? spec.createRustGraph
    : defaultCreateRustGraph;

  if (createRustGraph === defaultCreateRustGraph && !rustBinaryAvailable()) return null;

  const graph = createRustGraph({
    memoryPath: sandboxMemoryPath(),
    requestTimeoutMs: spec.requestTimeoutMs,
  });
  if (!graph || typeof graph._send !== 'function') return null;

  try {
    if (learn.length) {
      const res = await graph._send({
        cmd: 'batch',
        commands: learn.map(text => ({ cmd: 'learn', text })),
      });
      if (!isProcessResponse(graph, res)) return null;
    }
    if (!ask.length) return [];
    const res = await graph._send({
      cmd: 'batch',
      commands: ask.map(question => ({ cmd: 'ask', question })),
    });
    if (!isProcessResponse(graph, res)) return null;
    return (res.results || []).map(r => (r && r.answer) || 'Bilmiyorum');
  } finally {
    // Ends the child's stdin and kills it: the per-call Graph dies with it.
    if (typeof graph.destroy === 'function') graph.destroy();
  }
}

/**
 * True only for a reply that actually came back from a Rust process.
 *
 * RustGraph degrades to an in-process JS Graph when the binary is missing or
 * the spawn fails, and signals that by resolving `_send` with the fallback
 * object itself. That fallback answers nothing useful here (RustGraph#learn
 * reads `res.ok`, which a Graph does not have), so the sandbox treats it as
 * "no Rust backend" and lets the caller use its own JS kernel path instead.
 */
function isProcessResponse(graph, res) {
  if (!res || res === graph._fallback) return false;
  return res.ok !== false;
}

module.exports = { runRustSandbox, rustBinaryAvailable };
