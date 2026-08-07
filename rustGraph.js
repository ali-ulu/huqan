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

  _rejectAll() {
    for (const [reqId, cb] of this._pending) { cb({ ok: false, error: 'process_exited' }); }
    this._pending.clear();
  }

  _send(cmd) {
    return new Promise((resolve) => {
      this._start();
      if (this._fallback) {
        resolve(this._fallback);
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
      this._pending.set(reqId, resolve);
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

  async addNode(id, label) {
    const res = await this._send({ cmd: 'add_node', id, label });
    if (res === this._fallback) return this._fallback.addNode(id, label);
    if (!res.ok) return null;
    return { id, label, weight: 0.5 };
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

  async addEdge(fromId, toId, relation) {
    const res = await this._send({ cmd: 'add_edge', from: fromId, to: toId, relation });
    if (res === this._fallback) return this._fallback.addEdge(fromId, toId, relation);
    if (!res.ok) return null;
    return { from: fromId, to: toId, relation, weight: 0.5 };
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
    this._pending.clear();
  }
}

module.exports = RustGraph;
module.exports.resolveRustBin = resolveRustBin;
