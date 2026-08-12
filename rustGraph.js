const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Graph = require('./graph');

function resolveRustBin() {
  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'axiom-core.exe' : 'axiom-core';
  const candidates = [
    // Native build (cargo build --release, no explicit --target).
    path.join(__dirname, 'axiom-core', 'target', 'release', exeName),
    // Windows cross/GNU-toolchain build (see axiom-core/build.ps1).
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
    this._buf += chunk.toString();
    if (this._buf.length > RUST_MAX_LINE_BYTES) {
      // A malicious/buggy Rust process streaming huge or newline-less output
      // must not be allowed to grow this buffer without bound (OOM DoS, #372).
      // Reset and fail every in-flight request; a well-behaved process would
      // never produce a single reply line this large.
      this._buf = '';
      this._rejectAll('buffer_overflow');
      return;
    }
    const lines = this._buf.split('\n');
    this._buf = lines.pop() || '';
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

  async getNode(id) {
    const res = await this._send({ cmd: 'get_node', id });
    if (res === this._fallback) return this._fallback.getNode(id);
    if (!res.ok || !res.node) return null;
    return res.node;
  }

  async removeNode(id) {
    const res = await this._send({ cmd: 'remove_node', id });
    if (res === this._fallback) return this._fallback.removeNode(id);
    return res.ok;
  }

  async getWeight(id) {
    const res = await this._send({ cmd: 'get_weight', id });
    if (res === this._fallback) return this._fallback.getWeight(id);
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

  async getEdge(fromId, toId, relation) {
    // Fallback aktifse doğrudan fallback'e git
    if (this._fallback) return this._fallback.getEdge(fromId, toId, relation);
    const edges = await this.getEdges(fromId);
    // getEdges array döndürür (fallback durumunda zaten yukarıda yakalandı)
    if (!Array.isArray(edges)) return null;
    for (const e of edges) {
      if (e.to === toId && e.relation === relation) return e;
    }
    return null;
  }

  async getEdges(nodeId) {
    const res = await this._send({ cmd: 'get_edges', id: nodeId });
    if (res === this._fallback) return this._fallback.getEdges(nodeId);
    return res.edges || [];
  }

  async getInEdges(nodeId) {
    const res = await this._send({ cmd: 'get_in_edges', id: nodeId });
    if (res === this._fallback) return this._fallback.getInEdges(nodeId);
    return res.edges || [];
  }

  async query(label) {
    if (this._fallback) return this._fallback.query(label);
    const stats = await this.getStats();
    return [];
  }

  async nodeCount() {
    const s = await this.getStats();
    return s.nodes || 0;
  }

  async edgeCount() {
    const s = await this.getStats();
    return s.edges || 0;
  }

  async cosineSimilarity(aId, bId) {
    const res = await this._send({ cmd: 'cosine_similarity', a: aId, b: bId });
    if (res === this._fallback) return this._fallback.cosineSimilarity(aId, bId);
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

  async learn(text) {
    const res = await this._send({ cmd: 'learn', text });
    return res && res.ok;
  }

  async ask(question) {
    const res = await this._send({ cmd: 'ask', question });
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
