const { StringDecoder } = require('string_decoder');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Graph = require('./graph');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');

/**
 * Locate the native accelerator binary.
 *
 * The crate is `huqan-core`; it was `axiom-core` before RFC-001's rename, and
 * `target/` is gitignored, so a checkout that was built before the rename still
 * has a working binary under the old directory and name. Those paths are kept
 * as lower-priority candidates: without them such a checkout would silently
 * lose acceleration and fall back to the JavaScript Graph, which is correct but
 * slower and gives no hint why.
 *
 * Canonical paths are tried first, so a tree with both built prefers the
 * current one. The first canonical path is returned when nothing exists, which
 * is what makes a missing binary a clean fallback rather than an error.
 */
function resolveRustBin(environment = process.env) {
  const configured = readCompatibleEnvironmentVariable('RUST_BIN', environment);
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim());

  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'huqan-core.exe' : 'huqan-core';
  const legacyExeName = isWin ? 'axiom-core.exe' : 'axiom-core';
  const candidates = [
    // Native build (cargo build --release, no explicit --target).
    path.join(__dirname, 'huqan-core', 'target', 'release', exeName),
    // Windows cross/GNU-toolchain build (see huqan-core/build.ps1).
    path.join(__dirname, 'huqan-core', 'target', 'x86_64-pc-windows-gnu', 'release', 'huqan-core.exe'),
    // Pre-rename builds, accepted but never produced.
    path.join(__dirname, 'axiom-core', 'target', 'release', legacyExeName),
    path.join(__dirname, 'axiom-core', 'target', 'x86_64-pc-windows-gnu', 'release', 'axiom-core.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const RUST_BIN = resolveRustBin();
const RUST_REQUEST_TIMEOUT_MS = 10000;
const RUST_MAX_LINE_BYTES = 10 * 1024 * 1024;

class RustGraph {
  constructor(opts) {
    if (typeof opts === 'string') opts = { memoryPath: opts };
    opts = opts || {};
    this.memoryPath = opts.memoryPath || 'memory.json';
    this._fallback = null;
    this._proc = null;
    this._pending = new Map();
    this._nextId = 1;
    this._ready = false;
    this._buf = '';
    // Stdout chunks are Buffers -- setEncoding() is never called on the pipe --
    // and `this._buf += chunk.toString()` decoded each one on its own, so a
    // multi-byte UTF-8 character straddling a chunk boundary was split and each
    // half became U+FFFD. The corruption lands inside a JSON string value, so
    // the line still parses, `_reqId` still matches, and the mangled answer is
    // returned to the caller as an ordinary result with no error path taken.
    // Since the boundary falls wherever OS pipe buffering puts it, the same
    // query answered correctly or corruptly at random (#1030).
    //
    // StringDecoder is the stateful decoder for exactly this: it holds back an
    // incomplete character and emits it once the next chunk completes it.
    this._decoder = new StringDecoder('utf8');
    // `RUST_MAX_LINE_BYTES` was compared against `this._buf.length`, which
    // counts UTF-16 code units rather than bytes. It erred conservatively so it
    // was not a hole, but the name did not describe the check; this counts the
    // bytes that actually arrived.
    this._bufBytes = 0;
    this._requestTimeoutMs = Number.isFinite(opts.requestTimeoutMs) && opts.requestTimeoutMs > 0
      ? opts.requestTimeoutMs
      : RUST_REQUEST_TIMEOUT_MS;
  }

  _start() {
    // Both branches below are one-shot: once a Rust process is spawned OR the
    // JS fallback Graph is built, _start must not run again. Guarding only on
    // _proc meant every _send() rebuilt the fallback from scratch whenever the
    // Rust binary was absent, so addNode/addEdge/getStats each ran against a
    // different Graph instance and no state ever accumulated.
    if (this._proc || this._fallback) return;
    if (!fs.existsSync(RUST_BIN)) {
      this._fallback = new Graph({ memoryPath: this.memoryPath });
      this._ready = true;
      return;
    }
    try {
      this._proc = spawn(RUST_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this._proc.stdout.on('data', (chunk) => this._onData(chunk));
      this._proc.on('exit', () => { this._proc = null; this._rejectAll(); });
      this._proc.on('error', () => { this._fallback = new Graph({ memoryPath: this.memoryPath }); this._ready = true; });
      this._proc.stdin.on('error', () => {});
      this._proc.unref();
      this._proc.stdin.unref();
      this._proc.stdout.unref();
      this._proc.stderr.unref();
      this._ready = true;
    } catch {
      this._fallback = new Graph({ memoryPath: this.memoryPath });
      this._ready = true;
    }
  }

  _onData(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this._bufBytes += buf.length;
    this._buf += this._decoder.write(buf);
    if (this._bufBytes > RUST_MAX_LINE_BYTES) {
      // A malicious/buggy Rust process streaming huge or newline-less output
      // must not be allowed to grow this buffer without bound (OOM DoS, #372).
      // Reset and fail every in-flight request; a well-behaved process would
      // never produce a single reply line this large.
      this._buf = '';
      this._bufBytes = 0;
      // The abandoned stream may have left a partial character held back.
      this._decoder = new StringDecoder('utf8');
      this._rejectAll('buffer_overflow');
      return;
    }
    const lines = this._buf.split('\n');
    this._buf = lines.pop() || '';
    // Only the unconsumed remainder still counts against the cap. When no line
    // completed, `_buf` is unchanged and the running total is already right --
    // which is what keeps a newline-less flood bounded.
    if (lines.length > 0) this._bufBytes = Buffer.byteLength(this._buf, 'utf8');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const reqId = parsed._reqId;
      if (reqId != null && this._pending.has(reqId)) {
        this._pending.get(reqId)(parsed);
        this._pending.delete(reqId);
      }
    }
    this._unrefIfIdle();
  }

  _rejectAll(error = 'process_exited') {
    for (const [reqId, cb] of this._pending) { cb({ ok: false, error }); }
    this._pending.clear();
  }

  _send(cmd) {
    return new Promise((resolve) => {
      this._start();
      if (this._fallback) {
        resolve(this._fallback);
        return;
      }
      if (!this._proc || !this._proc.stdin) {
        // Process died between _start() and here (async 'exit'/'error');
        // don't crash on a write to a torn-down stdin (#373).
        resolve({ ok: false, error: 'process_unavailable' });
        return;
      }
      const reqId = this._nextId++;
      cmd._reqId = reqId;
      // The process/streams are unref()'d at spawn time so an idle bridge
      // never keeps a long-running host process (e.g. a server) alive. But
      // that also means a caller `await`-ing a response can have the event
      // loop close out from under them before the reply arrives. Ref while
      // a request is in flight; _onData/_rejectAll unref again once idle.
      this._proc.ref();
      this._proc.stdin.ref();
      this._proc.stdout.ref();
      // Guard against a Rust process that never replies (hang/deadlock): without
      // this, a caller's await would block forever (#373).
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          this._unrefIfIdle();
          resolve({ ok: false, error: 'request_timeout' });
        }
      }, this._requestTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this._pending.set(reqId, (parsed) => {
        clearTimeout(timer);
        resolve(parsed);
      });
      this._proc.stdin.write(JSON.stringify(cmd) + '\n');
    });
  }

  _unrefIfIdle() {
    if (this._pending.size === 0 && this._proc) {
      this._proc.unref();
      this._proc.stdin.unref();
      this._proc.stdout.unref();
    }
  }

  async addNode(id, label, opts = {}) {
    // provenance/workspaceId are forwarded to the Rust process so they are
    // not silently dropped when the Rust backend is active (#361).
    const cmd = { cmd: 'add_node', id, label };
    if (opts && opts.provenance !== undefined) cmd.provenance = opts.provenance;
    if (opts && opts.workspaceId !== undefined) cmd.workspaceId = opts.workspaceId;
    const res = await this._send(cmd);
    if (res === this._fallback) return this._fallback.addNode(id, label, opts.provenance, opts);
    if (!res.ok) return null;
    return { id, label, weight: 0.5, provenance: opts.provenance ?? null, workspaceId: opts.workspaceId };
  }

  // The read side takes the same workspace selector as graph.js, and defaults
  // to `default` rather than to "every workspace": an unscoped read must not
  // see another tenant's node just because it shares an id (#759).
  async getNode(id, workspaceId = 'default') {
    const res = await this._send({ cmd: 'get_node', id, workspaceId });
    if (res === this._fallback) return this._fallback.getNode(id, workspaceId);
    if (!res.ok || !res.node) return null;
    return res.node;
  }

  async removeNode(id, workspaceId = 'default') {
    const res = await this._send({ cmd: 'remove_node', id, workspaceId });
    if (res === this._fallback) return this._fallback.removeNode(id, workspaceId);
    return res.ok;
  }

  async getWeight(id, workspaceId = 'default') {
    const res = await this._send({ cmd: 'get_weight', id, workspaceId });
    if (res === this._fallback) return this._fallback.getWeight(id, workspaceId);
    return res.weight || 0;
  }

  async addEdge(fromId, toId, relation, opts = {}) {
    // provenance/workspaceId/weight/confidence/evidence/sourceRef are forwarded
    // to the Rust process so they are not silently dropped when the Rust
    // backend is active (#361).
    const cmd = { cmd: 'add_edge', from: fromId, to: toId, relation };
    if (opts && opts.provenance !== undefined) cmd.provenance = opts.provenance;
    if (opts && opts.workspaceId !== undefined) cmd.workspaceId = opts.workspaceId;
    if (opts && opts.weight !== undefined) cmd.weight = opts.weight;
    if (opts && opts.confidence !== undefined) cmd.confidence = opts.confidence;
    if (opts && opts.evidence !== undefined) cmd.evidence = opts.evidence;
    if (opts && opts.sourceRef !== undefined) cmd.sourceRef = opts.sourceRef;
    const res = await this._send(cmd);
    if (res === this._fallback) return this._fallback.addEdge(fromId, toId, relation, opts);
    if (!res.ok) return null;
    return {
      from: fromId,
      to: toId,
      relation,
      weight: opts.weight ?? 0.5,
      confidence: opts.confidence,
      evidence: opts.evidence,
      sourceRef: opts.sourceRef,
      provenance: opts.provenance ?? null,
      workspaceId: opts.workspaceId,
    };
  }

  async getEdge(fromId, toId, relation, workspaceId = 'default') {
    // Fallback aktifse doğrudan fallback'e git
    if (this._fallback) return this._fallback.getEdge(fromId, toId, relation, workspaceId);
    const edges = await this.getEdges(fromId, workspaceId);
    // getEdges array döndürür (fallback durumunda zaten yukarıda yakalandı)
    if (!Array.isArray(edges)) return null;
    for (const e of edges) {
      if (e.to === toId && e.relation === relation) return e;
    }
    return null;
  }

  async getEdges(nodeId, workspaceId = 'default') {
    const res = await this._send({ cmd: 'get_edges', id: nodeId, workspaceId });
    if (res === this._fallback) return this._fallback.getEdges(nodeId, workspaceId);
    return res.edges || [];
  }

  async getInEdges(nodeId, workspaceId = 'default') {
    const res = await this._send({ cmd: 'get_in_edges', id: nodeId, workspaceId });
    if (res === this._fallback) return this._fallback.getInEdges(nodeId, workspaceId);
    return res.edges || [];
  }

  // #1142: this used to fetch getStats(), throw the result away and return []
  // whenever the accelerator was live, so a label lookup that worked in the JS
  // fallback silently returned nothing on a Rust-enabled deployment. It is now
  // a real 'query' command, and workspaceId is accepted for parity with
  // Graph.query(label, workspaceId).
  async query(label, workspaceId = 'default') {
    const res = await this._send({ cmd: 'query', label, workspaceId });
    if (res === this._fallback) return this._fallback.query(label, workspaceId);
    return res.nodes || [];
  }

  async nodeCount() {
    const s = await this.getStats();
    return s.nodes || 0;
  }

  async edgeCount() {
    const s = await this.getStats();
    return s.edges || 0;
  }

  async cosineSimilarity(aId, bId, workspaceId = 'default') {
    const res = await this._send({ cmd: 'cosine_similarity', a: aId, b: bId, workspaceId });
    if (res === this._fallback) return this._fallback.cosineSimilarity(aId, bId, workspaceId);
    return res.similarity || 0;
  }

  async prune(threshold) {
    const res = await this._send({ cmd: 'prune', threshold: String(threshold || 0.01) });
    if (res === this._fallback) return this._fallback.prune(threshold);
    return res.pruned || 0;
  }

  async optimize() {
    const res = await this._send({ cmd: 'optimize' });
    if (res === this._fallback) return this._fallback.optimize();
    return { pruned: res.pruned || 0, removedNodes: res.removed_nodes || 0 };
  }

  async getStats() {
    const res = await this._send({ cmd: 'stats' });
    if (res === this._fallback) return this._fallback.getStats();
    return res.stats || { nodes: 0, edges: 0, decayLambda: 0.05 };
  }

  async learn(text, opts = {}) {
    const cmd = { cmd: 'learn', text };
    if (opts && opts.workspaceId !== undefined) cmd.workspaceId = opts.workspaceId;
    const res = await this._send(cmd);
    return res && res.ok;
  }

  /**
   * Learn several statements in one IPC round trip. This is intentionally a
   * RustGraph accelerator surface, not a replacement for Kernel.learn(): the
   * canonical Kernel path remains synchronous and admission/durability-governed.
   * @param {string[]} texts
   * @param {object} [opts]
   * @returns {Promise<{ok: boolean, results: object[], error?: string}>}
   */
  async learnBatch(texts, opts = {}) {
    const statements = Array.isArray(texts) ? texts.filter(text => typeof text === 'string') : [];
    const workspaceId = opts && opts.workspaceId !== undefined ? opts.workspaceId : undefined;
    const commands = statements.map(text => {
      const command = { cmd: 'learn', text };
      if (workspaceId !== undefined) command.workspaceId = workspaceId;
      return command;
    });
    const res = await this._send({ cmd: 'batch', commands });
    if (res === this._fallback) return { ok: false, results: [], error: 'rust_unavailable' };
    if (!res || res.ok !== true || !Array.isArray(res.results)) {
      return { ok: false, results: [], error: res?.error || 'invalid_response' };
    }
    return { ok: true, results: res.results };
  }

  async ask(question, opts = {}) {
    const cmd = { cmd: 'ask', question };
    if (opts && opts.workspaceId !== undefined) cmd.workspaceId = opts.workspaceId;
    const res = await this._send(cmd);
    if (!res || !res.ok) return 'Bilmiyorum';
    return res.answer;
  }

  async save(memPath) {
    if (this._fallback) { this._fallback.save(); return; }
    const res = await this._send({ cmd: 'save', path: memPath || this.memoryPath });
    return res && res.ok;
  }

  async load(memPath) {
    if (this._fallback) { this._fallback.load(); return; }
    const res = await this._send({ cmd: 'load', path: memPath || this.memoryPath });
    return res && res.ok;
  }

  destroy() {
    if (this._proc) {
      this._proc.stdin.end();
      this._proc.kill();
      this._proc = null;
    }
    if (this._fallback) {
      // The JS-fallback Graph holds an open SQLite handle (and WAL/SHM files)
      // once it is built. Leaving it open after destroy() is a genuine
      // resource leak: on Windows it blocks removal of the directory the
      // fallback's memoryPath lives in.
      try { this._fallback.close(); } catch (_) {}
      this._fallback = null;
    }
    this._pending.clear();
  }
}

module.exports = RustGraph;
module.exports.resolveRustBin = resolveRustBin;
