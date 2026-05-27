var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};

// ../graph.js
var require_graph = __commonJS({
  "../graph.js"(exports, module2) {
    var fs = require("fs");
    var path = require("path");
    var Database;
    try {
      Database = require("better-sqlite3");
    } catch (_) {
      Database = null;
    }
    var Graph = class {
      /**
       * @param {object|string} [opts]
       * @param {string}  [opts.memoryPath]      - JSON hafıza dosyası (varsayılan: memory.json)
       * @param {string}  [opts.dbPath]          - SQLite dosyası (varsayılan: memory.db, null = devre dışı)
       * @param {boolean} [opts.useSQLite]       - SQLite kullan (varsayılan: true, eğer better-sqlite3 varsa)
       * @param {number}  [opts.decayLambda]
       * @param {number}  [opts.pruneThreshold]
       */
      constructor(opts) {
        if (typeof opts === "string")
          opts = { memoryPath: opts };
        opts = opts || {};
        this.memoryPath = opts.memoryPath || "memory.json";
        this._embeddingPath = this.memoryPath.replace(/\.json$/, ".embeddings.json");
        this._decayLambda = opts.decayLambda || 0.05;
        this._pruneThreshold = opts.pruneThreshold || 0.01;
        this._nodes = {};
        this._edges = [];
        this._outIndex = /* @__PURE__ */ new Map();
        this._inIndex = /* @__PURE__ */ new Map();
        const wantSQLite = opts.useSQLite !== false && Database !== null;
        this._db = null;
        if (wantSQLite) {
          const dbPath = opts.dbPath || this.memoryPath.replace(/\.json$/, ".db");
          try {
            this._db = new Database(dbPath);
            this._initDB();
          } catch (e) {
            console.error("[Graph] SQLite ba\u015Flat\u0131lamad\u0131, JSON fallback:", e.message);
            this._db = null;
          }
        }
      }
      // ─── SQLite şema ──────────────────────────────────────────────────────────
      _initDB() {
        this._db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        created INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        vector TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'manual',
        evidence TEXT NOT NULL DEFAULT '[]',
        created INTEGER NOT NULL,
        UNIQUE(from_id, to_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id);
    `);
        const edgeColumns = this._db.prepare("PRAGMA table_info(edges)").all().map((c) => c.name);
        if (!edgeColumns.includes("confidence"))
          this._db.exec("ALTER TABLE edges ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5");
        if (!edgeColumns.includes("source"))
          this._db.exec("ALTER TABLE edges ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
        if (!edgeColumns.includes("evidence"))
          this._db.exec("ALTER TABLE edges ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]'");
        this._stmts = {
          upsertNode: this._db.prepare(`
        INSERT INTO nodes (id, label, weight, created, last_accessed, vector)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          weight = MIN(1.0, weight + 0.1),
          last_accessed = excluded.last_accessed
      `),
          getNode: this._db.prepare("SELECT * FROM nodes WHERE id = ?"),
          deleteNode: this._db.prepare("DELETE FROM nodes WHERE id = ?"),
          deleteEdgesOf: this._db.prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?"),
          touchNode: this._db.prepare("UPDATE nodes SET last_accessed = ? WHERE id = ?"),
          upsertEdge: this._db.prepare(`
        INSERT INTO edges (from_id, to_id, relation, weight, confidence, source, evidence, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
          weight = excluded.weight,
          confidence = excluded.confidence,
          source = excluded.source,
          evidence = excluded.evidence
      `),
          getEdge: this._db.prepare("SELECT * FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?"),
          getEdges: this._db.prepare("SELECT * FROM edges WHERE from_id = ?"),
          getInEdges: this._db.prepare("SELECT * FROM edges WHERE to_id = ?"),
          pruneEdges: this._db.prepare("DELETE FROM edges WHERE weight < ?"),
          countNodes: this._db.prepare("SELECT COUNT(*) as c FROM nodes"),
          countEdges: this._db.prepare("SELECT COUNT(*) as c FROM edges"),
          allNodes: this._db.prepare("SELECT * FROM nodes"),
          allEdges: this._db.prepare("SELECT * FROM edges"),
          updateEdgeWeight: this._db.prepare("UPDATE edges SET weight = ?, confidence = ?, source = ?, evidence = ? WHERE from_id = ? AND to_id = ? AND relation = ?"),
          updateNodeVector: this._db.prepare("UPDATE nodes SET vector = ? WHERE id = ?")
        };
      }
      // ─── Node işlemleri ───────────────────────────────────────────────────────
      addNode(id, label) {
        const now = Date.now();
        if (this._db) {
          const existing = this._stmts.getNode.get(id);
          const vector = existing ? existing.vector : "{}";
          this._stmts.upsertNode.run(id, label, 0.5, now, now, vector);
          if (this._nodes[id]) {
            this._nodes[id].label = label;
            this._nodes[id].weight = Math.min(1, this._nodes[id].weight + 0.1);
            this._nodes[id].lastAccessed = now;
          } else {
            this._nodes[id] = { id, label, tags: [], vector: {}, weight: 0.5, created: now, lastAccessed: now };
          }
        } else {
          if (this._nodes[id]) {
            this._nodes[id].label = label;
            this._nodes[id].weight = Math.min(1, this._nodes[id].weight + 0.1);
            this._nodes[id].lastAccessed = now;
          } else {
            this._nodes[id] = { id, label, tags: [], vector: {}, weight: 0.5, created: now, lastAccessed: now };
          }
        }
        return this._nodes[id];
      }
      getNode(id) {
        if (!this._nodes[id])
          return null;
        this._nodes[id].lastAccessed = Date.now();
        if (this._db) {
          this._stmts.touchNode.run(Date.now(), id);
        }
        return this._nodes[id];
      }
      removeNode(id) {
        if (!this._nodes[id])
          return false;
        delete this._nodes[id];
        this._edges = this._edges.filter((e) => e.from !== id && e.to !== id);
        this._rebuildIndex();
        if (this._db) {
          this._stmts.deleteEdgesOf.run(id, id);
          this._stmts.deleteNode.run(id);
        }
        return true;
      }
      getWeight(id) {
        if (!this._nodes[id])
          return 0;
        const node = this._nodes[id];
        const elapsed = (Date.now() - node.lastAccessed) / 1e3;
        const decayed = node.weight * Math.exp(-this._decayLambda * elapsed);
        return Math.max(0, Math.min(1, decayed));
      }
      addTag(nodeId, dim, weight) {
        if (!this._nodes[nodeId])
          return;
        const v = this._nodes[nodeId].vector;
        v[dim] = (v[dim] || 0) + weight;
      }
      // ─── Edge işlemleri ───────────────────────────────────────────────────────
      addEdge(fromId, toId, relation, opts = {}) {
        var _a, _b, _c, _d, _e, _f, _g;
        if (!this._nodes[fromId] || !this._nodes[toId])
          return null;
        const existing = this.getEdge(fromId, toId, relation);
        const nextEvidence = Array.isArray(opts.evidence) ? opts.evidence : [];
        if (existing) {
          existing.weight = Math.min(1, (_a = opts.weight) != null ? _a : existing.weight + 0.1);
          existing.confidence = Math.max((_b = existing.confidence) != null ? _b : existing.weight, (_d = (_c = opts.confidence) != null ? _c : existing.confidence) != null ? _d : existing.weight);
          if (opts.source)
            existing.source = opts.source;
          existing.evidence = [.../* @__PURE__ */ new Set([...existing.evidence || [], ...nextEvidence])];
          if (this._db) {
            this._stmts.updateEdgeWeight.run(
              existing.weight,
              existing.confidence,
              existing.source || "manual",
              JSON.stringify(existing.evidence || []),
              fromId,
              toId,
              relation
            );
          }
          return existing;
        }
        const edge = {
          from: fromId,
          to: toId,
          relation,
          weight: (_e = opts.weight) != null ? _e : 0.5,
          confidence: (_g = (_f = opts.confidence) != null ? _f : opts.weight) != null ? _g : 0.5,
          source: opts.source || "manual",
          evidence: nextEvidence,
          created: Date.now()
        };
        this._edges.push(edge);
        this._indexEdge(edge);
        if (this._db) {
          this._stmts.upsertEdge.run(
            fromId,
            toId,
            relation,
            edge.weight,
            edge.confidence,
            edge.source,
            JSON.stringify(edge.evidence || []),
            edge.created
          );
        }
        return edge;
      }
      getEdge(fromId, toId, relation) {
        const out = this._outIndex.get(fromId);
        if (!out)
          return null;
        for (const e of out) {
          if (e.to === toId && e.relation === relation)
            return e;
        }
        return null;
      }
      getEdgesBetween(fromId, toId) {
        const out = this._outIndex.get(fromId) || [];
        return out.filter((e) => e.to === toId);
      }
      hasAnyEdge(fromId, toId) {
        return this.getEdgesBetween(fromId, toId).length > 0;
      }
      getEdges(nodeId) {
        return this._outIndex.get(nodeId) || [];
      }
      getInEdges(nodeId) {
        return this._inIndex.get(nodeId) || [];
      }
      query(label) {
        return Object.values(this._nodes).filter((n) => n.label === label);
      }
      nodeCount() {
        return Object.keys(this._nodes).length;
      }
      edgeCount() {
        return this._edges.length;
      }
      cosineSimilarity(aId, bId) {
        const a = this._nodes[aId];
        const b = this._nodes[bId];
        if (!a || !b)
          return 0;
        const dims = /* @__PURE__ */ new Set([...Object.keys(a.vector), ...Object.keys(b.vector)]);
        let dot = 0, magA = 0, magB = 0;
        for (const d of dims) {
          const va = a.vector[d] || 0;
          const vb = b.vector[d] || 0;
          dot += va * vb;
          magA += va * va;
          magB += vb * vb;
        }
        const mag = Math.sqrt(magA) * Math.sqrt(magB);
        return mag === 0 ? 0 : dot / mag;
      }
      prune(threshold) {
        if (threshold === void 0)
          threshold = this._pruneThreshold;
        const before = this._edges.length;
        this._edges = this._edges.filter((e) => e.weight >= threshold);
        this._rebuildIndex();
        const pruned = before - this._edges.length;
        if (this._db && pruned > 0) {
          this._stmts.pruneEdges.run(threshold);
        }
        return pruned;
      }
      optimize() {
        const now = Date.now();
        let pruned = this.prune();
        const nodeIds = Object.keys(this._nodes);
        let removedNodes = 0;
        for (const id of nodeIds) {
          const node = this._nodes[id];
          const elapsed = (now - node.lastAccessed) / 1e3;
          const decayed = node.weight * Math.exp(-this._decayLambda * elapsed);
          const outEdges = this.getEdges(id);
          const inEdges = this.getInEdges(id);
          if (decayed < 0.01 && outEdges.length === 0 && inEdges.length === 0) {
            delete this._nodes[id];
            if (this._db)
              this._stmts.deleteNode.run(id);
            removedNodes++;
          }
        }
        return { pruned, removedNodes };
      }
      getStats() {
        return {
          nodes: this.nodeCount(),
          edges: this.edgeCount(),
          decayLambda: this._decayLambda,
          backend: this._db ? "sqlite" : "json"
        };
      }
      // ─── Kalıcılık ────────────────────────────────────────────────────────────
      _stripEmbeddings() {
        const embeddings = {};
        for (const [id, node] of Object.entries(this._nodes)) {
          if (node.embedding) {
            embeddings[id] = Array.from(node.embedding);
            delete node.embedding;
          }
        }
        return embeddings;
      }
      _restoreEmbeddings(embeddings) {
        for (const [id, vec] of Object.entries(embeddings)) {
          if (this._nodes[id]) {
            this._nodes[id].embedding = new Float64Array(vec);
          }
        }
      }
      save() {
        this.prune();
        const embeddings = this._stripEmbeddings();
        if (this._db) {
          const saveAll = this._db.transaction(() => {
            var _a, _b;
            for (const node of Object.values(this._nodes)) {
              this._db.prepare(`
            INSERT INTO nodes (id, label, weight, created, last_accessed, vector)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label,
              weight = excluded.weight,
              last_accessed = excluded.last_accessed,
              vector = excluded.vector
          `).run(
                node.id,
                node.label,
                node.weight,
                node.created,
                node.lastAccessed,
                JSON.stringify(node.vector || {})
              );
            }
            for (const edge of this._edges) {
              this._db.prepare(`
            INSERT INTO edges (from_id, to_id, relation, weight, confidence, source, evidence, created)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
              weight = excluded.weight,
              confidence = excluded.confidence,
              source = excluded.source,
              evidence = excluded.evidence
          `).run(
                edge.from,
                edge.to,
                edge.relation,
                edge.weight,
                (_b = (_a = edge.confidence) != null ? _a : edge.weight) != null ? _b : 0.5,
                edge.source || "manual",
                JSON.stringify(edge.evidence || []),
                edge.created
              );
            }
          });
          saveAll();
        }
        const data = { nodes: this._nodes, edges: this._edges };
        fs.writeFileSync(this.memoryPath, JSON.stringify(data));
        this._restoreEmbeddings(embeddings);
        if (Object.keys(embeddings).length > 0) {
          fs.writeFileSync(this._embeddingPath, JSON.stringify(embeddings));
        }
      }
      load() {
        if (this._db) {
          try {
            const nodes = this._stmts.allNodes.all();
            const edges = this._stmts.allEdges.all();
            if (nodes.length > 0) {
              this._nodes = {};
              for (const row of nodes) {
                this._nodes[row.id] = {
                  id: row.id,
                  label: row.label,
                  weight: row.weight,
                  created: row.created,
                  lastAccessed: row.last_accessed,
                  tags: [],
                  vector: JSON.parse(row.vector || "{}")
                };
              }
              this._edges = edges.map((row) => {
                var _a, _b;
                return {
                  from: row.from_id,
                  to: row.to_id,
                  relation: row.relation,
                  weight: row.weight,
                  confidence: (_b = (_a = row.confidence) != null ? _a : row.weight) != null ? _b : 0.5,
                  source: row.source || "manual",
                  evidence: JSON.parse(row.evidence || "[]"),
                  created: row.created
                };
              });
              this._rebuildIndex();
              if (fs.existsSync(this._embeddingPath)) {
                try {
                  const emb = JSON.parse(fs.readFileSync(this._embeddingPath, "utf-8"));
                  this._restoreEmbeddings(emb);
                } catch (_) {
                }
              }
              return;
            }
          } catch (e) {
            console.error("[Graph] SQLite y\xFCkleme hatas\u0131, JSON fallback:", e.message);
          }
        }
        if (!fs.existsSync(this.memoryPath))
          return;
        try {
          const data = JSON.parse(fs.readFileSync(this.memoryPath, "utf-8"));
          this._nodes = data.nodes || {};
          this._edges = (data.edges || []).map((edge) => {
            var _a, _b;
            return {
              ...edge,
              confidence: (_b = (_a = edge.confidence) != null ? _a : edge.weight) != null ? _b : 0.5,
              source: edge.source || "manual",
              evidence: Array.isArray(edge.evidence) ? edge.evidence : []
            };
          });
          this._rebuildIndex();
          if (fs.existsSync(this._embeddingPath)) {
            try {
              const emb = JSON.parse(fs.readFileSync(this._embeddingPath, "utf-8"));
              this._restoreEmbeddings(emb);
            } catch (_) {
            }
          }
          if (this._db && Object.keys(this._nodes).length > 0) {
            this.save();
          }
        } catch (e) {
          console.error("Load error:", e.message);
        }
      }
      // ─── Index yönetimi ───────────────────────────────────────────────────────
      _indexEdge(edge) {
        if (!this._outIndex.has(edge.from))
          this._outIndex.set(edge.from, []);
        this._outIndex.get(edge.from).push(edge);
        if (!this._inIndex.has(edge.to))
          this._inIndex.set(edge.to, []);
        this._inIndex.get(edge.to).push(edge);
      }
      _rebuildIndex() {
        this._outIndex.clear();
        this._inIndex.clear();
        for (const e of this._edges)
          this._indexEdge(e);
      }
      // ─── Temizlik ─────────────────────────────────────────────────────────────
      close() {
        if (this._db) {
          try {
            this._db.close();
          } catch (_) {
          }
          this._db = null;
        }
      }
    };
    module2.exports = Graph;
  }
});

// ../dream.js
var require_dream = __commonJS({
  "../dream.js"(exports, module2) {
    var Dream = class {
      constructor(kernel) {
        this.kernel = kernel;
        this.graph = kernel.graph;
      }
      _emit(event, data) {
        if (this.kernel && this.kernel.plugins && typeof this.kernel.plugins.emit === "function") {
          this.kernel.plugins.emit(event, data);
        }
        return data;
      }
      // ─── Embedding ────────────────────────────────────────────────────────────
      embedding(opts = {}) {
        this._emit("beforeEmbedding", opts);
        const dims = opts.dimensions || 64;
        const walksPerNode = opts.walksPerNode || 10;
        const walkLength = opts.walkLength || 20;
        const windowSize = opts.windowSize || 5;
        const p = opts.p || 1;
        const q = opts.q || 1;
        const nodes = Object.keys(this.graph._nodes);
        if (nodes.length < 2)
          return null;
        const walks = [];
        for (const id of nodes) {
          for (let w = 0; w < walksPerNode; w++) {
            walks.push(this._biasedWalk(id, walkLength, p, q));
          }
        }
        const cooc = /* @__PURE__ */ new Map();
        for (const walk of walks) {
          for (let i = 0; i < walk.length; i++) {
            const center = walk[i];
            if (!cooc.has(center))
              cooc.set(center, /* @__PURE__ */ new Map());
            const ctx = cooc.get(center);
            const start = Math.max(0, i - windowSize);
            const end = Math.min(walk.length - 1, i + windowSize);
            for (let j = start; j <= end; j++) {
              if (i === j)
                continue;
              ctx.set(walk[j], (ctx.get(walk[j]) || 0) + 1);
            }
          }
        }
        for (const id of nodes) {
          const ctx = cooc.get(id) || /* @__PURE__ */ new Map();
          const vec = new Float64Array(dims);
          const node = this.graph._nodes[id];
          for (let d = 0; d < dims; d++) {
            let sum = 0;
            for (const [contextId, count] of ctx) {
              sum += count * this._projectionWeight(contextId, d, dims);
            }
            const signature = this._nodeSignatureWeight(node, d, dims);
            vec[d] = sum + signature * 0.18;
          }
          let mag = 0;
          for (let d = 0; d < dims; d++)
            mag += vec[d] * vec[d];
          mag = Math.sqrt(mag);
          if (mag > 0)
            for (let d = 0; d < dims; d++)
              vec[d] /= mag;
          this.graph._nodes[id].embedding = vec;
        }
        const result = { dimensions: dims, nodes: nodes.length };
        this._emit("afterEmbedding", result);
        return result;
      }
      /**
       * Geliştirilmiş projeksiyon ağırlığı.
       * Eski _hash sadece +1/-1 döndürüyordu — bu çok kaba.
       * Şimdi Gaussian benzeri sürekli değer üretiyoruz (FNV-1a tabanlı).
       */
      _projectionWeight(str, dim, totalDims) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
          h ^= str.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        let h2 = h ^ dim * 2654435761;
        h2 = Math.imul(h2 ^ h2 >>> 16, 73244475);
        h2 = Math.imul(h2 ^ h2 >>> 16, 73244475);
        h2 = h2 ^ h2 >>> 16;
        return h2 / 2147483648 - 1;
      }
      _nodeSignatureWeight(node, dim, totalDims) {
        const edges = this.graph.getEdges(node.id);
        const inEdges = this.graph.getInEdges(node.id);
        const label = String(node.label || node.id || "");
        const relationProfile = edges.map((e) => `${e.relation}:${e.to}`).sort().join("|");
        const seed = [
          `id:${node.id}`,
          `label:${label}`,
          `deg:${edges.length}`,
          `indeg:${inEdges.length}`,
          `rels:${relationProfile}`
        ].join("::");
        const idSignal = this._projectionWeight(seed, dim, totalDims);
        const labelSignal = this._projectionWeight(`label:${label}`, dim, totalDims);
        const degreeSignal = this._projectionWeight(`degree:${edges.length}:${inEdges.length}`, dim, totalDims);
        return idSignal * 0.58 + labelSignal * 0.27 + degreeSignal * 0.15;
      }
      nodeSimilarity(a, b) {
        var _a, _b;
        const va = (_a = this.graph._nodes[a]) == null ? void 0 : _a.embedding;
        const vb = (_b = this.graph._nodes[b]) == null ? void 0 : _b.embedding;
        if (!va || !vb)
          return 0;
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < va.length; i++) {
          dot += va[i] * vb[i];
          magA += va[i] * va[i];
          magB += vb[i] * vb[i];
        }
        const mag = Math.sqrt(magA) * Math.sqrt(magB);
        return mag === 0 ? 0 : dot / mag;
      }
      findSimilar(nodeId, n = 5) {
        const ids = Object.keys(this.graph._nodes);
        const scored = ids.filter((id) => id !== nodeId).map((id) => ({ id, score: this.nodeSimilarity(nodeId, id) })).filter((s) => s.score > 0);
        return scored.sort((a, b) => b.score - a.score).slice(0, n);
      }
      // ─── Random Walk ──────────────────────────────────────────────────────────
      _biasedWalk(start, length, p, q) {
        const path = [start];
        const visited = /* @__PURE__ */ new Set([start]);
        let prev = null;
        let current = start;
        for (let i = 0; i < length; i++) {
          const edges = this.graph.getEdges(current);
          const candidates = edges.filter((e) => !visited.has(e.to));
          if (candidates.length === 0)
            break;
          const weights = candidates.map((e) => {
            if (prev === null)
              return e.weight;
            if (e.to === prev)
              return e.weight / p;
            const prevEdges = this.graph.getEdges(prev);
            const connected = prevEdges.some((pe) => pe.to === e.to);
            return e.weight / (connected ? 1 : q);
          });
          const total = weights.reduce((s, w) => s + w, 0);
          if (total === 0)
            break;
          let r = Math.random() * total;
          let pick = candidates[candidates.length - 1];
          for (let j = 0; j < candidates.length; j++) {
            r -= weights[j];
            if (r <= 0) {
              pick = candidates[j];
              break;
            }
          }
          path.push(pick.to);
          visited.add(pick.to);
          prev = current;
          current = pick.to;
        }
        return path;
      }
      // ─── Composite Skorlama ──────────────────────────────────────────────────
      _calculateCompositeScore(hyp) {
        const confidence = hyp.confidence || 0.3;
        let novelty = 0;
        if (hyp.type === "\xE7eli\u015Fki") {
          novelty = 1;
        } else if (hyp.from && hyp.to) {
          const exists = this.graph.getEdges(hyp.from).some((e) => e.to === hyp.to) || this.graph.getEdges(hyp.to).some((e) => e.to === hyp.from);
          novelty = exists ? 0 : 1;
        }
        let usefulness = 0;
        const nodeId = hyp.from || hyp.node;
        if (nodeId) {
          const outDeg = this.graph.getEdges(nodeId).length;
          const inDeg = this.graph.getInEdges(nodeId).length;
          const deg = outDeg + inDeg;
          const nodes = Object.values(this.graph._nodes);
          const avgDeg = nodes.reduce((s, n) => {
            return s + this.graph.getEdges(n.id).length + this.graph.getInEdges(n.id).length;
          }, 0) / Math.max(1, nodes.length);
          usefulness = avgDeg > 0 ? Math.min(1, deg / avgDeg) : 0;
        }
        return {
          score: confidence * 0.5 + novelty * 0.3 + usefulness * 0.2,
          confidence,
          novelty,
          usefulness
        };
      }
      // ─── Dream (Hipotez Üretimi) ──────────────────────────────────────────────
      dream() {
        this._emit("beforeDream", {});
        const nodes = Object.values(this.graph._nodes);
        if (nodes.length < 2) {
          this._emit("afterDream", { hypotheses: [] });
          return [];
        }
        const hypotheses = [];
        this._findSimilarityHypotheses(nodes, hypotheses);
        this._findTransitiveHypotheses(nodes, hypotheses);
        this._findGapHypotheses(nodes, hypotheses);
        this._findSymmetryHypotheses(nodes, hypotheses);
        this._findContradictionHypotheses(nodes, hypotheses);
        const scored = hypotheses.map((h) => ({
          ...h,
          ...this._calculateCompositeScore(h)
        }));
        const contradictions = scored.filter((h) => h.type === "\xE7eli\u015Fki");
        const others = scored.filter((h) => h.type !== "\xE7eli\u015Fki");
        contradictions.sort((a, b) => b.confidence - a.confidence);
        others.sort((a, b) => b.score - a.score);
        const result = [...contradictions, ...others].slice(0, 10);
        this._emit("afterDream", { hypotheses: result });
        return result;
      }
      _findSimilarityHypotheses(nodes, hypotheses) {
        const checked = /* @__PURE__ */ new Set();
        let added = 0;
        for (let i = 0; i < nodes.length && added < 50; i++) {
          for (let j = i + 1; j < nodes.length && added < 50; j++) {
            const a = nodes[i], b = nodes[j];
            const key = `${a.id}|${b.id}`;
            if (checked.has(key))
              continue;
            checked.add(key);
            const aEdges = this.graph.getEdges(a.id);
            const bEdges = this.graph.getEdges(b.id);
            const aTargets = new Set(aEdges.map((e) => e.to));
            const bTargets = new Set(bEdges.map((e) => e.to));
            const common = [...aTargets].filter((t) => bTargets.has(t));
            if (common.length > 0) {
              const existing = this.graph.getEdge(a.id, b.id, "benzer") || this.graph.getEdge(b.id, a.id, "benzer");
              if (!existing) {
                const avgWeight = common.reduce((s, t) => {
                  const ae = aEdges.find((e) => e.to === t);
                  const be = bEdges.find((e) => e.to === t);
                  return s + (ae ? ae.weight : 0) + (be ? be.weight : 0);
                }, 0) / (common.length * 2);
                hypotheses.push({
                  type: "benzerlik",
                  from: a.id,
                  to: b.id,
                  via: common[0],
                  confidence: Math.min(0.7, 0.2 + avgWeight * 0.4 * common.length),
                  ortak_say\u0131s\u0131: common.length
                });
                added++;
              }
            }
            const sim = this.graph.cosineSimilarity(a.id, b.id);
            if (sim > 0.5) {
              const hasEdge = this.graph.hasAnyEdge(a.id, b.id) || this.graph.hasAnyEdge(b.id, a.id);
              if (!hasEdge) {
                hypotheses.push({
                  type: "vekt\xF6r-benzerlik",
                  from: a.id,
                  to: b.id,
                  confidence: Math.min(0.5, sim * 0.6),
                  benzerlik: sim
                });
                added++;
              }
            }
          }
        }
      }
      _findTransitiveHypotheses(nodes, hypotheses) {
        let added = 0;
        for (const node of nodes) {
          if (added >= 50)
            break;
          const edges = this.graph.getEdges(node.id);
          for (const edge of edges) {
            if (added >= 50)
              break;
            const transEdges = this.graph.getEdges(edge.to);
            for (const te of transEdges) {
              if (added >= 50)
                break;
              if (te.to === node.id)
                continue;
              const existing = this.graph.getEdge(node.id, te.to, edge.relation);
              if (!existing) {
                hypotheses.push({
                  type: "zincir",
                  from: node.id,
                  to: te.to,
                  via: edge.to,
                  confidence: Math.min(0.6, edge.weight * te.weight * 3),
                  relation: edge.relation
                });
                added++;
              }
            }
          }
        }
      }
      _findGapHypotheses(nodes, hypotheses) {
        const gaps = this.kernel.detectGaps();
        if (gaps.length === 0 || nodes.length < 2)
          return;
        let added = 0;
        for (const gapId of gaps) {
          if (added >= 50)
            break;
          const gapNode = this.graph.getNode(gapId);
          if (!gapNode)
            continue;
          let best = null, bestSim = 0;
          for (const n of nodes) {
            if (n.id === gapId)
              continue;
            const sim = this.graph.cosineSimilarity(gapId, n.id);
            if (sim > bestSim) {
              bestSim = sim;
              best = n.id;
            }
          }
          if (best && bestSim > 0.1) {
            hypotheses.push({
              type: "ba\u011Flant\u0131-\xF6nerisi",
              from: gapId,
              to: best,
              confidence: Math.min(0.4, bestSim * 0.5),
              benzerlik: bestSim
            });
            added++;
          }
        }
      }
      _findSymmetryHypotheses(nodes, hypotheses) {
        let added = 0;
        for (const node of nodes) {
          if (added >= 50)
            break;
          const edges = this.graph.getEdges(node.id);
          for (const edge of edges) {
            if (added >= 50)
              break;
            const reverse = this.graph.getEdge(edge.to, node.id, edge.relation);
            const reverseAny = this.graph.hasAnyEdge(edge.to, node.id);
            if (!reverse && !reverseAny) {
              hypotheses.push({
                type: "simetri",
                from: edge.to,
                to: node.id,
                via: edge.relation,
                confidence: edge.weight * 0.3,
                relation: edge.relation
              });
              added++;
            }
          }
        }
      }
      _findContradictionHypotheses(nodes, hypotheses) {
        if (typeof this.kernel.detectContradictions !== "function")
          return;
        try {
          const contradictions = this.kernel.detectContradictions();
          let added = 0;
          for (const c of contradictions) {
            if (added >= 50)
              break;
            hypotheses.push({
              type: "\xE7eli\u015Fki",
              node: c.node,
              targets: c.targets,
              confidence: c.confidence || 0.4
            });
            added++;
          }
        } catch (_) {
        }
      }
      // ─── Amplify / Simulate / Verify ─────────────────────────────────────────
      amplify(subject, candidates, relation) {
        const scored = candidates.map((c) => {
          const edge = this.graph.getEdge(subject, c, relation);
          const verified = this.verify(subject, c);
          return {
            answer: c,
            score: edge ? edge.weight * (verified.valid ? 1 : 0.5) : verified.valid ? 0.3 : 0,
            verified: verified.valid
          };
        });
        for (let iter = 0; iter < 5; iter++) {
          const totalScore = scored.reduce((sum, s) => sum + s.score, 0);
          if (totalScore === 0)
            break;
          for (const s of scored) {
            if (s.score > 0) {
              const edge = this.graph.getEdge(subject, s.answer, relation);
              if (edge) {
                const ratio = s.score / totalScore;
                edge.weight = Math.min(1, edge.weight + ratio * 0.1);
              }
            }
          }
        }
        return scored.sort((a, b) => b.score - a.score).map((s) => s.answer);
      }
      simulate(subject) {
        const node = this.graph.getNode(subject);
        if (!node)
          return [];
        const edges = this.graph.getEdges(subject);
        const scored = edges.map((e) => ({
          answer: e.to,
          score: e.weight * (e.relation === "t\xFCr" ? 1.2 : 1)
        }));
        const allNodes = Object.values(this.graph._nodes);
        for (const n of allNodes) {
          if (n.id !== subject && !scored.some((s) => s.answer === n.id)) {
            const sim = this.graph.cosineSimilarity(subject, n.id);
            if (sim > 0.3)
              scored.push({ answer: n.id, score: sim * 0.5 });
          }
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, 3);
      }
      verify(subject, object) {
        const visited = /* @__PURE__ */ new Set();
        const path = [];
        const found = this._dfs(subject, object, visited, path, 5);
        if (found) {
          return { valid: true, confidence: this._pathConfidence(path), path };
        }
        return { valid: false, confidence: 0, path: [] };
      }
      _dfs(current, target, visited, path, depth) {
        if (depth <= 0 || visited.has(current))
          return false;
        visited.add(current);
        path.push(current);
        if (current === target)
          return true;
        for (const e of this.graph.getEdges(current)) {
          if (!visited.has(e.to) && this._dfs(e.to, target, visited, path, depth - 1))
            return true;
        }
        for (const ie of this.graph.getInEdges(current)) {
          if (!visited.has(ie.from) && this._dfs(ie.from, target, visited, path, depth - 1))
            return true;
        }
        path.pop();
        visited.delete(current);
        return false;
      }
      _pathConfidence(path) {
        let conf = 1;
        for (let i = 0; i < path.length - 1; i++) {
          const edge = this.graph.getEdges(path[i]).find((e) => e.to === path[i + 1]) || this.graph.getInEdges(path[i]).find((e) => e.from === path[i + 1]);
          if (edge)
            conf *= edge.weight;
        }
        return conf;
      }
      walk(start, maxDepth) {
        const path = [start];
        const visited = /* @__PURE__ */ new Set([start]);
        let current = start;
        for (let i = 0; i < maxDepth; i++) {
          const edges = this.graph.getEdges(current).filter((e) => !visited.has(e.to));
          if (edges.length === 0)
            break;
          const pick = edges.sort((a, b) => b.weight - a.weight)[0];
          path.push(pick.to);
          visited.add(pick.to);
          current = pick.to;
        }
        return path;
      }
    };
    module2.exports = Dream;
  }
});

// ../plugin.js
var require_plugin = __commonJS({
  "../plugin.js"(exports, module2) {
    var fs = require("fs");
    var path = require("path");
    var crypto = require("crypto");
    var EVENTS = [
      "beforeLearn",
      "afterLearn",
      "beforeAsk",
      "afterAsk",
      "beforeDream",
      "afterDream",
      "beforeEmbedding",
      "afterEmbedding",
      "beforeIntrospect",
      "afterIntrospect",
      "beforePlan",
      "afterPlan",
      "beforeTask",
      "afterTask",
      "beforeAgentRun",
      "afterAgentRun"
    ];
    function hashFile(filePath) {
      return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    }
    function hmacSign(value, signingKey) {
      return crypto.createHmac("sha256", String(signingKey)).update(String(value)).digest("hex");
    }
    function getManifestPath(filePath) {
      const parsed = path.parse(filePath);
      return path.join(parsed.dir, `${parsed.name}.manifest.json`);
    }
    function readManifest(filePath) {
      const manifestPath = getManifestPath(filePath);
      if (!fs.existsSync(manifestPath))
        return null;
      return {
        manifestPath,
        manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      };
    }
    function verifyPluginFile(filePath, opts = {}) {
      const strict = opts.strict === true;
      const signatureKey = opts.signatureKey || process.env.AXIOM_PLUGIN_SIGNING_KEY || "";
      const currentHash = hashFile(filePath);
      const manifestRecord = readManifest(filePath);
      if (!manifestRecord) {
        return {
          ok: !strict,
          status: strict ? "rejected" : "unverified",
          sha256: currentHash,
          manifestPath: getManifestPath(filePath),
          reason: strict ? "Plugin manifest is required in strict mode." : "Plugin manifest not found."
        };
      }
      const { manifest, manifestPath } = manifestRecord;
      if (!manifest || typeof manifest !== "object") {
        return {
          ok: false,
          status: "rejected",
          sha256: currentHash,
          manifestPath,
          reason: "Plugin manifest is invalid."
        };
      }
      if (manifest.sha256 !== currentHash) {
        return {
          ok: false,
          status: "rejected",
          sha256: currentHash,
          manifestPath,
          reason: "Plugin hash mismatch."
        };
      }
      if (signatureKey) {
        if (!manifest.signature) {
          return {
            ok: !strict,
            status: strict ? "rejected" : "hash-only",
            sha256: currentHash,
            manifestPath,
            reason: strict ? "Plugin signature is required in strict mode." : "Plugin signature not found."
          };
        }
        const expectedSignature = hmacSign(currentHash, signatureKey);
        if (manifest.signature !== expectedSignature) {
          return {
            ok: false,
            status: "rejected",
            sha256: currentHash,
            manifestPath,
            reason: "Plugin signature mismatch."
          };
        }
      }
      return {
        ok: true,
        status: signatureKey ? "verified-signed" : "verified",
        sha256: currentHash,
        manifestPath,
        reason: signatureKey ? "Plugin hash and signature verified." : "Plugin hash verified."
      };
    }
    var PluginManager = class {
      constructor(kernel) {
        this.kernel = kernel;
        this.plugins = [];
        this._handlers = {};
        this.strictPlugins = process.env.AXIOM_PLUGIN_STRICT === "1";
        this.pluginSigningKey = process.env.AXIOM_PLUGIN_SIGNING_KEY || "";
        for (const e of EVENTS)
          this._handlers[e] = [];
      }
      load(dir) {
        const pDir = path.resolve(dir);
        if (!fs.existsSync(pDir))
          return 0;
        const files = fs.readdirSync(pDir).filter((f) => f.endsWith(".js"));
        let count = 0;
        for (const file of files) {
          const filePath = path.join(pDir, file);
          try {
            const verification = verifyPluginFile(filePath, {
              strict: this.strictPlugins,
              signatureKey: this.pluginSigningKey
            });
            if (!verification.ok) {
              console.error(`Plugin yuklenemedi: ${file} - ${verification.reason}`);
              continue;
            }
            const plugin = require(filePath);
            plugin.__verification = verification;
            this.register(plugin);
            count++;
          } catch (err) {
            console.error(`Plugin yuklenemedi: ${file} - ${err.message}`);
          }
        }
        return count;
      }
      register(plugin) {
        if (!plugin || !plugin.name)
          return;
        this.plugins.push(plugin);
        if (typeof plugin.init === "function") {
          plugin.init(this.kernel, this);
        }
        for (const event of EVENTS) {
          if (typeof plugin[event] === "function") {
            this._handlers[event].push(plugin);
          }
        }
      }
      emit(event, data) {
        for (const plugin of this._handlers[event]) {
          try {
            plugin[event](this.kernel, data);
          } catch (err) {
            console.error(`Plugin hatasi [${plugin.name}][${event}]: ${err.message}`);
          }
        }
        return data;
      }
    };
    module2.exports = PluginManager;
    module2.exports.hashFile = hashFile;
    module2.exports.hmacSign = hmacSign;
    module2.exports.verifyPluginFile = verifyPluginFile;
  }
});

// ../nlp/lang-tr.js
var require_lang_tr = __commonJS({
  "../nlp/lang-tr.js"(exports, module2) {
    var NORMALIZE_MAP = {
      "\u0131": "i",
      "\u0130": "i",
      "I": "i"
    };
    var PLURAL_SUFFIXES = ["lar", "ler"];
    var STOP_WORDS = /* @__PURE__ */ new Set([
      "ve",
      "veya",
      "ile",
      "de",
      "da",
      "ki",
      "bu",
      "\u015Fu",
      "o",
      "bir",
      "i\xE7in",
      "gibi",
      "kadar",
      "daha",
      "en",
      "\xE7ok",
      "az",
      "her",
      "hi\xE7",
      "ne",
      "nas\u0131l",
      "neden",
      "ni\xE7in",
      "nerede",
      "kim",
      "hangi"
    ]);
    function normalize(word) {
      let w = String(word || "").toLowerCase().trim();
      w = w.replace(/i\u0307/g, "i").replace(/\u0307/g, "");
      w = w.split("").map((c) => NORMALIZE_MAP[c] || c).join("");
      for (const suf of PLURAL_SUFFIXES) {
        if (w.endsWith(suf) && w.length > suf.length + 2) {
          w = w.slice(0, w.length - suf.length);
          break;
        }
      }
      return w;
    }
    function tokenize(text) {
      return String(text || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    }
    function isStopWord(word) {
      return STOP_WORDS.has(normalize(word));
    }
    function extractFacts(text, knownNodes = null) {
      const raw = String(text || "").toLowerCase().trim();
      const words = raw.split(/\s+/).filter(Boolean);
      if (words.length < 2)
        return [];
      const filtered = words.filter((w) => w !== "bir" && w !== "de" && w !== "da");
      if (filtered.length < 2)
        return [];
      const veIdx = filtered.indexOf("ve");
      if (veIdx === 1 && filtered.length >= 4) {
        const subjectA = normalize(filtered[0]);
        const subjectB = normalize(filtered[2]);
        const predicate2 = filtered.slice(3).join(" ");
        return [
          { subject: subjectA, predicate: predicate2 },
          { subject: subjectB, predicate: predicate2 }
        ];
      }
      if (knownNodes) {
        const nodeIds = typeof knownNodes === "object" && !Array.isArray(knownNodes) ? Object.keys(knownNodes) : Array.isArray(knownNodes) ? knownNodes : [];
        for (let len = Math.min(3, filtered.length - 1); len >= 2; len--) {
          const candidate = normalize(filtered.slice(0, len).join(" "));
          if (nodeIds.includes(candidate) || nodeIds.some((n) => normalize(n) === candidate)) {
            const predicate2 = filtered.slice(len).join(" ");
            return [{ subject: candidate, predicate: predicate2 }];
          }
        }
      }
      const subject = normalize(filtered[0]);
      const predicate = filtered.slice(1).join(" ");
      return [{ subject, predicate }];
    }
    module2.exports = {
      name: "turkish",
      normalize,
      tokenize,
      isStopWord,
      extractFacts
    };
  }
});

// ../nlp/lang-en.js
var require_lang_en = __commonJS({
  "../nlp/lang-en.js"(exports, module2) {
    var STOP_WORDS = /* @__PURE__ */ new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "to",
      "of",
      "in",
      "on",
      "for",
      "with",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being"
    ]);
    function normalize(word) {
      let w = String(word || "").toLowerCase().trim();
      w = w.replace(/[^a-z0-9-]/g, "");
      for (const suf of ["ing", "ed", "es", "s"]) {
        if (w.endsWith(suf) && w.length > suf.length + 2) {
          w = w.slice(0, -suf.length);
          break;
        }
      }
      return w;
    }
    function tokenize(text) {
      return String(text || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    }
    function isStopWord(word) {
      return STOP_WORDS.has(normalize(word));
    }
    function extractFacts(text) {
      const rawTokens = tokenize(text);
      if (rawTokens.length < 2)
        return [];
      const andIdx = rawTokens.indexOf("and");
      if (andIdx === 1 && rawTokens.length >= 4) {
        const subjectA = normalize(rawTokens[0]);
        const subjectB = normalize(rawTokens[2]);
        const predicate = rawTokens.slice(3).filter((t) => !isStopWord(t)).join(" ");
        return [
          { subject: subjectA, predicate },
          { subject: subjectB, predicate }
        ];
      }
      const tokens = rawTokens.filter((t) => !isStopWord(t));
      if (tokens.length < 2)
        return [];
      const isIdx = tokens.findIndex((t) => ["is", "are", "was", "were"].includes(t));
      if (isIdx > 0) {
        const subject = normalize(tokens.slice(0, isIdx).join(" "));
        const predicate = tokens.slice(isIdx + 1).join(" ");
        if (subject && predicate) {
          return [{ subject, predicate }];
        }
      }
      return [{
        subject: normalize(tokens[0]),
        predicate: tokens.slice(1).join(" ")
      }];
    }
    module2.exports = {
      name: "english",
      normalize,
      tokenize,
      isStopWord,
      extractFacts
    };
  }
});

// ../nlp/lang-de.js
var require_lang_de = __commonJS({
  "../nlp/lang-de.js"(exports, module2) {
    var STOP_WORDS = /* @__PURE__ */ new Set([
      "der",
      "die",
      "das",
      "ein",
      "eine",
      "und",
      "oder",
      "ist",
      "sind",
      "war",
      "waren",
      "zu",
      "von",
      "mit",
      "f\xFCr",
      "auf",
      "im",
      "in",
      "am",
      "an"
    ]);
    function normalize(word) {
      let w = String(word || "").toLowerCase().trim();
      w = w.replace(/[^a-z0-9äöüß-]/g, "");
      return w;
    }
    function tokenize(text) {
      return String(text || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    }
    function isStopWord(word) {
      return STOP_WORDS.has(normalize(word));
    }
    function extractFacts(text) {
      const rawTokens = tokenize(text);
      if (rawTokens.length < 2)
        return [];
      const andIdx = rawTokens.indexOf("und");
      if (andIdx === 1 && rawTokens.length >= 4) {
        const subjectA = normalize(rawTokens[0]);
        const subjectB = normalize(rawTokens[2]);
        const predicate = rawTokens.slice(3).filter((t) => !isStopWord(t)).join(" ");
        return [
          { subject: subjectA, predicate },
          { subject: subjectB, predicate }
        ];
      }
      const copulaIdx = rawTokens.findIndex((t) => ["ist", "sind", "war", "waren"].includes(t));
      if (copulaIdx > 0) {
        const subject = normalize(rawTokens.slice(0, copulaIdx).join(" "));
        const predicate = rawTokens.slice(copulaIdx + 1).filter((t) => !isStopWord(t)).join(" ");
        if (subject && predicate) {
          return [{ subject, predicate }];
        }
      }
      const tokens = rawTokens.filter((t) => !isStopWord(t));
      if (tokens.length < 2)
        return [];
      return [{
        subject: normalize(tokens[0]),
        predicate: tokens.slice(1).join(" ")
      }];
    }
    module2.exports = {
      name: "german",
      normalize,
      tokenize,
      isStopWord,
      extractFacts
    };
  }
});

// ../nlp/lang-ar.js
var require_lang_ar = __commonJS({
  "../nlp/lang-ar.js"(exports, module2) {
    var STOP_WORDS = /* @__PURE__ */ new Set([
      "\u0627\u0644",
      "\u0648",
      "\u0623\u0648",
      "\u0641\u064A",
      "\u0639\u0644\u0649",
      "\u0645\u0646",
      "\u0625\u0644\u0649",
      "\u0627\u0644\u0649",
      "\u0639\u0646",
      "\u0645\u0639",
      "\u0647\u0630\u0627",
      "\u0647\u0630\u0647",
      "\u0647\u0648",
      "\u0647\u064A",
      "\u0647\u0645",
      "\u0647\u0646",
      "\u0643\u0627\u0646",
      "\u062A\u0643\u0648\u0646",
      "\u064A\u0643\u0648\u0646"
    ]);
    function normalize(word) {
      let w = String(word || "").toLowerCase().trim();
      w = w.replace(/[^\u0600-\u06ff0-9-]/g, "");
      w = w.replace(/^ال+/u, "");
      return w;
    }
    function tokenize(text) {
      return String(text || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    }
    function isStopWord(word) {
      return STOP_WORDS.has(normalize(word));
    }
    function extractFacts(text) {
      const rawTokens = tokenize(text);
      if (rawTokens.length < 2)
        return [];
      const andIdx = rawTokens.indexOf("\u0648");
      if (andIdx === 1 && rawTokens.length >= 4) {
        const subjectA = normalize(rawTokens[0]);
        const subjectB = normalize(rawTokens[2]);
        const predicate = rawTokens.slice(3).filter((t) => !isStopWord(t)).join(" ");
        return [
          { subject: subjectA, predicate },
          { subject: subjectB, predicate }
        ];
      }
      if (rawTokens.length >= 4 && rawTokens[1].startsWith("\u0648")) {
        const copulaIdx2 = rawTokens.findIndex((t) => ["\u0647\u0648", "\u0647\u064A", "\u0647\u0645", "\u0647\u0646", "\u064A\u0643\u0648\u0646", "\u062A\u0643\u0648\u0646", "\u0643\u0627\u0646"].includes(t));
        if (copulaIdx2 === 2) {
          const subjectA = normalize(rawTokens[0]);
          const subjectB = normalize(rawTokens[1].slice(1));
          const predicate = rawTokens.slice(copulaIdx2 + 1).filter((t) => !isStopWord(t)).join(" ");
          return [
            { subject: subjectA, predicate },
            { subject: subjectB, predicate }
          ];
        }
      }
      const copulaIdx = rawTokens.findIndex((t) => ["\u0647\u0648", "\u0647\u064A", "\u0647\u0645", "\u0647\u0646", "\u064A\u0643\u0648\u0646", "\u062A\u0643\u0648\u0646", "\u0643\u0627\u0646"].includes(t));
      if (copulaIdx > 0) {
        const subject = normalize(rawTokens.slice(0, copulaIdx).join(" "));
        const predicate = rawTokens.slice(copulaIdx + 1).filter((t) => !isStopWord(t)).join(" ");
        if (subject && predicate)
          return [{ subject, predicate }];
      }
      const tokens = rawTokens.filter((t) => !isStopWord(t));
      if (tokens.length < 2)
        return [];
      return [{
        subject: normalize(tokens[0]),
        predicate: tokens.slice(1).join(" ")
      }];
    }
    module2.exports = {
      name: "arabic",
      normalize,
      tokenize,
      isStopWord,
      extractFacts
    };
  }
});

// ../nlp/index.js
var require_nlp = __commonJS({
  "../nlp/index.js"(exports, module2) {
    var tr = require_lang_tr();
    var en = require_lang_en();
    var de = require_lang_de();
    var ar = require_lang_ar();
    var PACKS = {
      tr,
      turkish: tr,
      en,
      english: en,
      de,
      german: de,
      deutsch: de,
      ar,
      arabic: ar,
      arabi: ar
    };
    function detectLanguage(text) {
      const sample = String(text || "").toLowerCase();
      if (!sample)
        return "tr";
      if (/[\u0600-\u06ff]/.test(sample))
        return "ar";
      if (/[äöüß]/.test(sample))
        return "de";
      if (/[çğıöşü]/.test(sample))
        return "tr";
      const words = sample.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
      const hasAny = (set) => words.some((word) => set.has(word));
      const arHints = /* @__PURE__ */ new Set(["\u0647\u0648", "\u0647\u064A", "\u0643\u0627\u0646", "\u062A\u0643\u0648\u0646", "\u064A\u0643\u0648\u0646", "\u0648\u0627\u0644", "\u0641\u064A", "\u0645\u0646", "\u0625\u0644\u0649", "\u0639\u0644\u0649"]);
      const deHints = /* @__PURE__ */ new Set(["der", "die", "das", "ist", "sind", "war", "waren", "und", "f\xFCr", "mit"]);
      const enHints = /* @__PURE__ */ new Set(["the", "is", "are", "was", "were", "and", "of", "with", "for"]);
      const trHints = /* @__PURE__ */ new Set(["ve", "veya", "bir", "i\xE7in", "gibi", "de\u011Fil", "d\u0131r", "dir", "d\u0131r", "mi", "m\u0131"]);
      if (hasAny(arHints))
        return "ar";
      if (hasAny(deHints))
        return "de";
      if (hasAny(trHints))
        return "tr";
      if (hasAny(enHints))
        return "en";
      return "tr";
    }
    function createAutoPack() {
      const base = tr;
      return {
        name: "auto",
        detectLanguage,
        normalize: base.normalize,
        tokenize: base.tokenize,
        isStopWord: base.isStopWord,
        extractFacts(text, knownNodes = null) {
          const lang = detectLanguage(text);
          const pack = PACKS[lang] || tr;
          return pack.extractFacts(text, knownNodes);
        }
      };
    }
    module2.exports = function createNlp(langCode = "tr") {
      const key = String(langCode || "tr").toLowerCase();
      if (key === "auto")
        return createAutoPack();
      return PACKS[key] || tr;
    };
  }
});

// ../rustGraph.js
var require_rustGraph = __commonJS({
  "../rustGraph.js"(exports, module2) {
    var { spawn } = require("child_process");
    var path = require("path");
    var fs = require("fs");
    var Graph = require_graph();
    var RUST_BIN = path.join(__dirname, "axiom-core", "target", "x86_64-pc-windows-gnu", "release", "axiom-core.exe");
    var RustGraph = class {
      constructor(opts) {
        if (typeof opts === "string")
          opts = { memoryPath: opts };
        opts = opts || {};
        this.memoryPath = opts.memoryPath || "memory.json";
        this._fallback = null;
        this._proc = null;
        this._pending = /* @__PURE__ */ new Map();
        this._nextId = 1;
        this._ready = false;
        this._buf = "";
      }
      _start() {
        if (this._proc)
          return;
        if (!fs.existsSync(RUST_BIN)) {
          this._fallback = new Graph({ memoryPath: this.memoryPath });
          this._ready = true;
          return;
        }
        try {
          this._proc = spawn(RUST_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
          this._proc.stdout.on("data", (chunk) => this._onData(chunk));
          this._proc.on("exit", () => {
            this._proc = null;
            this._rejectAll();
          });
          this._proc.on("error", () => {
            this._fallback = new Graph({ memoryPath: this.memoryPath });
            this._ready = true;
          });
          this._proc.stdin.on("error", () => {
          });
          this._proc.unref();
          this._proc.stdin.unref();
          this._proc.stdout.unref();
          this._proc.stderr.unref();
          this._ready = true;
        } catch (e) {
          this._fallback = new Graph({ memoryPath: this.memoryPath });
          this._ready = true;
        }
      }
      _onData(chunk) {
        this._buf += chunk.toString();
        const lines = this._buf.split("\n");
        this._buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim())
            continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch (e) {
            continue;
          }
          const id = parsed.id;
          if (id != null && this._pending.has(id)) {
            this._pending.get(id)(parsed);
            this._pending.delete(id);
          }
        }
      }
      _rejectAll() {
        for (const [id, cb] of this._pending) {
          cb({ ok: false, error: "process_exited" });
        }
        this._pending.clear();
      }
      _send(cmd) {
        return new Promise((resolve) => {
          this._start();
          if (this._fallback) {
            resolve(this._fallback);
            return;
          }
          const id = this._nextId++;
          cmd.id = id;
          this._pending.set(id, resolve);
          this._proc.stdin.write(JSON.stringify(cmd) + "\n");
        });
      }
      async addNode(id, label) {
        const res = await this._send({ cmd: "add_node", id, label });
        if (res === this._fallback)
          return this._fallback.addNode(id, label);
        if (!res.ok)
          return null;
        return { id, label, weight: 0.5 };
      }
      async getNode(id) {
        const res = await this._send({ cmd: "get_node", id });
        if (res === this._fallback)
          return this._fallback.getNode(id);
        if (!res.ok || !res.node)
          return null;
        return res.node;
      }
      async removeNode(id) {
        const res = await this._send({ cmd: "remove_node", id });
        if (res === this._fallback)
          return this._fallback.removeNode(id);
        return res.ok;
      }
      async getWeight(id) {
        const res = await this._send({ cmd: "get_weight", id });
        if (res === this._fallback)
          return this._fallback.getWeight(id);
        return res.weight || 0;
      }
      async addEdge(fromId, toId, relation) {
        const res = await this._send({ cmd: "add_edge", from: fromId, to: toId, relation });
        if (res === this._fallback)
          return this._fallback.addEdge(fromId, toId, relation);
        if (!res.ok)
          return null;
        return { from: fromId, to: toId, relation, weight: 0.5 };
      }
      async getEdge(fromId, toId, relation) {
        if (this._fallback)
          return this._fallback.getEdge(fromId, toId, relation);
        const edges = await this.getEdges(fromId);
        if (!Array.isArray(edges))
          return null;
        for (const e of edges) {
          if (e.to === toId && e.relation === relation)
            return e;
        }
        return null;
      }
      async getEdges(nodeId) {
        const res = await this._send({ cmd: "get_edges", id: nodeId });
        if (res === this._fallback)
          return this._fallback.getEdges(nodeId);
        return res.edges || [];
      }
      async getInEdges(nodeId) {
        const res = await this._send({ cmd: "get_in_edges", id: nodeId });
        if (res === this._fallback)
          return this._fallback.getInEdges(nodeId);
        return res.edges || [];
      }
      async query(label) {
        if (this._fallback)
          return this._fallback.query(label);
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
        const res = await this._send({ cmd: "cosine_similarity", a: aId, b: bId });
        if (res === this._fallback)
          return this._fallback.cosineSimilarity(aId, bId);
        return res.similarity || 0;
      }
      async prune(threshold) {
        const res = await this._send({ cmd: "prune", threshold: String(threshold || 0.01) });
        if (res === this._fallback)
          return this._fallback.prune(threshold);
        return res.pruned || 0;
      }
      async optimize() {
        const res = await this._send({ cmd: "optimize" });
        if (res === this._fallback)
          return this._fallback.optimize();
        return { pruned: res.pruned || 0, removedNodes: res.removed_nodes || 0 };
      }
      async getStats() {
        const res = await this._send({ cmd: "stats" });
        if (res === this._fallback)
          return this._fallback.getStats();
        return res.stats || { nodes: 0, edges: 0, decayLambda: 0.05 };
      }
      async learn(text) {
        const res = await this._send({ cmd: "learn", text });
        return res && res.ok;
      }
      async ask(question) {
        const res = await this._send({ cmd: "ask", question });
        if (!res || !res.ok)
          return "Bilmiyorum";
        return res.answer;
      }
      save() {
        if (this._fallback) {
          this._fallback.save();
          return;
        }
      }
      load() {
        if (this._fallback) {
          this._fallback.load();
          return;
        }
      }
      destroy() {
        if (this._proc) {
          this._proc.stdin.end();
          this._proc.kill();
          this._proc = null;
        }
        this._pending.clear();
      }
    };
    module2.exports = RustGraph;
  }
});

// ../kernel.js
var require_kernel = __commonJS({
  "../kernel.js"(exports, module2) {
    var Graph = require_graph();
    var Dream = require_dream();
    var fs = require("fs");
    var path = require("path");
    var PluginManager = require_plugin();
    var createNlp = require_nlp();
    var RustGraph;
    try {
      RustGraph = require_rustGraph();
    } catch (e) {
    }
    var RUST_BIN = process.env.AXIOM_RUST_BIN || path.join(__dirname, "axiom-core", "target", "x86_64-pc-windows-gnu", "release", "axiom-core.exe");
    var hasRust = fs.existsSync(RUST_BIN) && typeof RustGraph !== "undefined";
    var AXIOM_ERROR = Object.freeze({
      INVALID_INPUT: "INVALID_INPUT",
      CONFLICT_DETECTED: "CONFLICT_DETECTED",
      GRAPH_UNAVAILABLE: "GRAPH_UNAVAILABLE",
      NORMALIZATION_FAILED: "NORMALIZATION_FAILED",
      LLM_DISABLED: "LLM_DISABLED",
      INTERNAL: "INTERNAL"
    });
    var CONTRACT_VERSION = "1.0.0";
    var Kernel2 = class {
      /**
       * @param {object} [opts]
       * @param {boolean} [opts.noLoad=false] - true ise memory.json y?klenmez (test i?in)
       * @param {string}  [opts.memoryPath]   - ?zel haf?za dosyas? yolu
       */
      constructor(opts = {}) {
        /**
         * Periyodik bak?m â€” ?ÄŸrenme sayac?n? takip eder, e?ik a??l?nca selfEvolve ?al??tür?r.
         */
        __publicField(this, "_learnCount", 0);
        __publicField(this, "maintenanceEvery", 5);
        const graphOpts = {};
        if (opts.memoryPath)
          graphOpts.memoryPath = opts.memoryPath;
        if (opts.dbPath)
          graphOpts.dbPath = opts.dbPath;
        if (opts.useSQLite !== void 0)
          graphOpts.useSQLite = opts.useSQLite;
        if (opts.noLoad && !opts.memoryPath && !opts.dbPath && opts.useSQLite === void 0) {
          graphOpts.useSQLite = false;
        }
        this.graph = new Graph(graphOpts);
        if (!opts.noLoad)
          this.graph.load();
        this.paranoidMode = opts.paranoidMode === true || process.env.AXIOM_PARANOID === "1";
        this.contractVersion = CONTRACT_VERSION;
        this.lang = opts.lang || process.env.AXIOM_LANG || "tr";
        this.nlp = createNlp(this.lang);
        this._rust = hasRust ? new RustGraph() : null;
        this.plugins = new PluginManager(this);
        if (opts.loadPlugins !== false) {
          const pDir = path.join(__dirname, "plugins");
          if (fs.existsSync(pDir))
            this.plugins.load(pDir);
        }
      }
      normalizeWord(word) {
        return this.nlp.normalize(word);
      }
      tokenizeText(text) {
        return this.nlp.tokenize(text);
      }
      isStopWord(word) {
        return this.nlp.isStopWord(word);
      }
      extractFacts(text, knownNodes = null) {
        return this.nlp.extractFacts(text, knownNodes);
      }
      usePlugin(plugin) {
        this.plugins.register(plugin);
      }
      _ok(type, data = null, evidence = [], meta = {}) {
        const stats = this.graph && typeof this.graph.getStats === "function" ? this.graph.getStats() : {};
        return this._validateResult({
          ok: true,
          type,
          data,
          evidence: this._rankEvidence(Array.isArray(evidence) ? evidence : []),
          error: null,
          meta: {
            contractVersion: this.contractVersion,
            backend: stats.backend || "unknown",
            paranoidMode: this.paranoidMode,
            ...meta
          }
        });
      }
      _fail(type, code, message, meta = {}) {
        return this._validateResult({
          ok: false,
          type,
          data: null,
          evidence: [],
          error: { code, message },
          meta: {
            contractVersion: this.contractVersion,
            paranoidMode: this.paranoidMode,
            ...meta
          }
        });
      }
      _validateResult(result) {
        if (!result || typeof result.ok !== "boolean")
          throw new Error("Invalid result: ok must be boolean");
        if (!Array.isArray(result.evidence))
          throw new Error("Invalid result: evidence must be array");
        if (result.type === "verify" && result.data) {
          const statuses = /* @__PURE__ */ new Set(["dogrulandi", "celiski", "bilinmiyor"]);
          if (!statuses.has(result.data.status))
            throw new Error("Invalid verify status: " + result.data.status);
          if (typeof result.data.confidence !== "number" || result.data.confidence < 0 || result.data.confidence > 1) {
            throw new Error("Invalid confidence: must be between 0 and 1");
          }
        }
        return result;
      }
      _edgeRef(edge) {
        return { from: edge.from, to: edge.to, relation: edge.relation };
      }
      _rankEvidence(evidence = []) {
        const seen = /* @__PURE__ */ new Set();
        return evidence.filter(Boolean).sort((a, b) => {
          var _a, _b;
          return ((_a = b.confidence) != null ? _a : 0) - ((_b = a.confidence) != null ? _b : 0);
        }).filter((item) => {
          const key = `${item.kind || "evidence"}|${item.text || ""}`;
          if (seen.has(key))
            return false;
          seen.add(key);
          return true;
        });
      }
      _edgeEvidence(edge, kind = "direct_edge", confidence) {
        var _a, _b;
        const score = Math.max(0, Math.min(1, (_b = (_a = confidence != null ? confidence : edge.confidence) != null ? _a : edge.weight) != null ? _b : 0));
        const details = [];
        if (edge.relation)
          details.push(`relation=${edge.relation}`);
        if (edge.source)
          details.push(`source=${edge.source}`);
        details.push(`confidence=${score.toFixed(2)}`);
        return {
          kind,
          text: `${edge.from} --[${edge.relation}]--> ${edge.to} (${details.join(", ")})`,
          confidence: score,
          nodes: [edge.from, edge.to],
          edges: [this._edgeRef(edge)]
        };
      }
      _pathEvidence(pathArr, kind = "path", confidence = 0.5) {
        const edges = [];
        for (let i = 0; i < pathArr.length - 1; i++) {
          const direct = this.graph.getEdges(pathArr[i]).find((e) => e.to === pathArr[i + 1]);
          const reverse = this.graph.getInEdges(pathArr[i]).find((e) => e.from === pathArr[i + 1]);
          const edge = direct || reverse;
          if (edge)
            edges.push(this._edgeRef(edge));
        }
        return {
          kind,
          text: pathArr.join(" -> "),
          confidence: Math.max(0, Math.min(1, confidence)),
          nodes: [...pathArr],
          edges
        };
      }
      _contradictionEvidence(contradiction) {
        const targets = Array.isArray(contradiction.targets) ? contradiction.targets : [];
        const edges = Array.isArray(contradiction.edges) ? contradiction.edges.map((edge) => this._edgeRef(edge)) : targets.map((to) => ({ from: contradiction.node, to, relation: contradiction.relation || "t\xFCr" }));
        return {
          kind: "contradiction",
          text: contradiction.message || `${contradiction.node} conflicts with ${targets.join(", ")}`,
          confidence: Math.max(0, Math.min(1, contradiction.confidence || 0.7)),
          nodes: [contradiction.node, ...targets],
          edges
        };
      }
      learn(text) {
        const ev = this.plugins.emit("beforeLearn", { text });
        text = ev.text;
        const parsed = this.extractFacts(text, this.graph._nodes);
        if (!parsed)
          return this._ok("learn", { learned: 0, skipped: 1, conflicts: [] }, []);
        const conflicts = [];
        const alternatives = [];
        let learned = 0;
        const evidence = [];
        for (const { subject, predicate } of parsed) {
          if (!subject || this.isStopWord(subject))
            continue;
          const rel = this._parsePredicate(predicate);
          if (rel) {
            const { object, relation } = rel;
            if (this.isStopWord(object))
              continue;
            const existingEdges = this.graph.getEdges(subject).filter((e) => e.relation === relation);
            const existingTargets = existingEdges.map((e) => e.to);
            let celiskiBulundu = false;
            if (relation === "t\xFCr") {
              for (const existing of existingTargets) {
                if (existing !== object) {
                  const benzerlik = this.contextSimilarity(object, existing, subject);
                  if (benzerlik < 0.15) {
                    conflicts.push({
                      type: "alternative",
                      subject,
                      relation: "t\xFCr",
                      current: object,
                      existing,
                      confidence: parseFloat(benzerlik.toFixed(3))
                    });
                    celiskiBulundu = true;
                  }
                }
              }
            }
            if (relation === "de\u011Fil") {
              const turEdges = this.graph.getEdges(subject).filter((e) => e.relation === "t\xFCr");
              for (const tur of turEdges) {
                if (tur.to === object) {
                  const onceki = tur.weight;
                  tur.weight = 0.2;
                  tur.celiski = "downgraded";
                  conflicts.push({
                    type: "negation",
                    subject,
                    relation: "de\u011Fil",
                    current: object,
                    existing: tur.to,
                    message: `"${subject}" "${object} de\u011Fildir" deniyor (?nceden t\xFCr:${onceki}) ? t\xFCr weight d?r?ld?`,
                    confidence: 0
                  });
                  celiskiBulundu = true;
                }
              }
            }
            if (rel.kistlama && relation === "yapabilir") {
              const digerYapabilir = existingEdges.filter((e) => e.relation === "yapabilir" && e.to !== object);
              for (const dg of digerYapabilir) {
                conflicts.push({
                  type: "restriction",
                  subject,
                  relation: "yapabilir",
                  current: object,
                  existing: dg.to,
                  message: `"${subject}" sadece "${object}" yapabilir deniyor ama "${dg.to}" da yapabiliyor`,
                  confidence: 0
                });
                celiskiBulundu = true;
              }
            }
            if (existingTargets.length > 0 && !existingTargets.includes(object)) {
              alternatives.push({
                subject,
                relation,
                current: object,
                existing: existingTargets
              });
            }
            this.graph.addNode(subject, subject);
            this.graph.addNode(object, object);
            if (celiskiBulundu && relation === "t\xFCr") {
              const edge = this.graph.addEdge(subject, object, "benzer", { source: "alt", weight: 0.15, evidence: [text] });
              if (edge) {
                learned++;
                evidence.push(this._edgeEvidence(edge));
              }
            } else if (celiskiBulundu && relation === "de\u011Fil") {
            } else if (celiskiBulundu) {
              const edge = this.graph.addEdge(subject, object, relation, { source: "learn", weight: 0.2, evidence: [text] });
              if (rel.kistlama && edge)
                edge.kistlama = true;
              if (edge) {
                learned++;
                evidence.push(this._edgeEvidence(edge));
              }
            } else {
              const edge = this.graph.addEdge(subject, object, relation, { source: "learn", evidence: [text] });
              this.graph.addTag(subject, object, 0.3);
              this._crossLink(subject, object, relation);
              learned++;
              if (edge)
                evidence.push(this._edgeEvidence(edge));
            }
          }
        }
        this.plugins.emit("afterLearn", { text, conflicts, alternatives });
        if (this._rust) {
          this._rust.learn(text).catch(() => {
          });
        }
        if (learned > 0) {
          try {
            this.graph.save();
          } catch (_) {
          }
          if (typeof setImmediate !== "undefined")
            setImmediate(() => this._autoMaintain());
        }
        return this._ok("learn", {
          learned,
          skipped: parsed.length - learned,
          conflicts,
          alternatives
        }, evidence);
      }
      _parsePredicate(predicate) {
        predicate = predicate.replace(/^bir\s+/, "").trim();
        const kistlama = predicate.match(/^(sadece|yaln?zca|s?rf|ancak)\s+(.+)/i);
        if (kistlama) {
          const inner = kistlama[2];
          const parsed = this._parsePredicate(inner);
          if (parsed) {
            parsed.kistlama = true;
            parsed.object = inner;
            return parsed;
          }
        }
        const degilMatch = predicate.match(/^(.+?)\s+değildir$/i);
        if (degilMatch) {
          return { object: degilMatch[1].trim(), relation: "de\u011Fil" };
        }
        const degilSuffix = /^(.+?)değildir$/i;
        const dMatch = predicate.match(degilSuffix);
        if (dMatch && dMatch[1].trim()) {
          return { object: dMatch[1].trim(), relation: "de\u011Fil" };
        }
        const negVerbMatch = predicate.match(/^(.+?)\s+(.+)(mez|maz)$/i);
        if (negVerbMatch) {
          const verb = negVerbMatch[2] + negVerbMatch[3];
          return { object: (negVerbMatch[1] + " " + verb).trim(), relation: "de\u011Fil" };
        }
        const negSingle = predicate.match(/^(.+?)(mez|maz)$/i);
        if (negSingle && predicate.indexOf(" ") === -1) {
          return { object: predicate, relation: "de\u011Fil" };
        }
        const tirSuffix = /(dır|dir|dur|dır|tür|tir|tur|tür)$/i;
        if (tirSuffix.test(predicate)) {
          const stem = this.normalizeWord(predicate.replace(tirSuffix, ""));
          return { object: stem, relation: "t\xFCr" };
        }
        const tirMulti = /^(.+?)(dır|dir|dur|dır|tür|tir|tur|tür)$/i;
        const mMatch = predicate.match(tirMulti);
        if (mMatch && mMatch[1].includes(" ")) {
          return { object: mMatch[1].trim(), relation: "t\xFCr" };
        }
        const verbSuffix = /(ar|er|ır|ir|ur|ür|yor|acak|ecek|mak|mek)$/i;
        if (verbSuffix.test(predicate)) {
          return { object: predicate, relation: "yapabilir" };
        }
        if (/r$/i.test(predicate) && predicate.length > 2) {
          return { object: predicate, relation: "yapabilir" };
        }
        return { object: predicate, relation: "\xF6zellik" };
      }
      _crossLink(subject, object, relation) {
        const subjNode = this.graph.getNode(subject);
        const objNode = this.graph.getNode(object);
        if (!subjNode || !objNode)
          return;
        for (const tag of Object.keys(subjNode.vector)) {
          if (tag !== object && this.graph.getNode(tag) && objNode.vector[tag]) {
            const existing = this.graph.getEdge(subject, object, "benzer");
            if (!existing) {
              this.graph.addEdge(subject, object, "benzer");
            }
          }
        }
      }
      ask(question) {
        const ev = this.plugins.emit("beforeAsk", { question });
        question = ev.question;
        const raw = question.toLowerCase().trim();
        const cleaned = raw.replace(/\b(nedir|kimdir|nas\u0131l|nerede|nereden|nereye|ka\u00e7|hangi)\b/gi, "").trim();
        const _kokeIndirge = (s) => {
          let kok = s.replace(/mezsem$/, "me").replace(/mazsam$/, "ma").replace(/sem$/, "").replace(/sam$/, "").replace(/meliyim$/, "me").replace(/mal\u0131y\u0131m$/, "ma").replace(/yim$/, "").replace(/y\u0131m$/, "").replace(/yum$/, "").replace(/y\u00fcm$/, "").replace(/m$/, "").replace(/im$/, "").replace(/s\u0131n$/, "").replace(/sin$/, "").replace(/sun$/, "").replace(/s\u00fcn$/, "").replace(/yorsun$/, "").replace(/yor$/, "");
          if (kok.endsWith("meliyim"))
            kok = kok.slice(0, -7);
          return kok.trim();
        };
        const _ozneBul = (s) => {
          const parts2 = s.split(/\s+/).filter(Boolean);
          if (parts2.length === 0)
            return { subject: "axiom", verb: "" };
          const ilk = parts2[0];
          const normalized = this.normalizeWord(ilk);
          if (this.graph.getNode(normalized)) {
            return { subject: normalized, verb: parts2.slice(1).join(" ") };
          }
          const fiilKok = _kokeIndirge(ilk);
          const normKok = this.normalizeWord(fiilKok);
          if (this.graph.getNode(normKok)) {
            return { subject: "axiom", verb: normKok };
          }
          if (parts2.length > 1) {
            const son = parts2[parts2.length - 1];
            const sonKok = _kokeIndirge(son);
            const normSon = this.normalizeWord(sonKok);
            const sifati = parts2.slice(0, -1).join(" ") + " " + sonKok;
            if (this.graph.getNode(normSon)) {
              return { subject: "axiom", verb: sifati, sifat: parts2.slice(0, -1).join(" ") };
            }
            return { subject: "axiom", verb: s };
          }
          return { subject: normalized, verb: "" };
        };
        if (/^(neden|ni?in|niye)\b/.test(raw)) {
          const action = raw.replace(/^(neden|ni?in|niye)\s+/, "");
          const { subject: subject2 } = _ozneBul(action);
          const subj = this.normalizeWord(subject2);
          return this.reason(subj || "axiom");
        }
        if (/ne olur/.test(raw) || /\w+sa\b/.test(raw) || /\w+se\b/.test(raw)) {
          const action = raw.replace(/\s+ne olur.*$/, "").replace(/\s+olursa.*$/, "").trim();
          const { subject: subject2, verb } = _ozneBul(action);
          const subj = this.graph.getNode(verb && this.normalizeWord(verb)) ? this.normalizeWord(verb) : this.normalizeWord(subject2);
          if (this.graph.getNode(subj)) {
            return this.reason(subj);
          }
        }
        const parts = cleaned.split(/\s+/).filter(Boolean);
        const { subject: detected } = _ozneBul(parts[0] || "");
        const subject = detected;
        const node = this.graph.getNode(subject);
        const finalSubject = node ? subject : "axiom";
        const finalNode = this.graph.getNode(finalSubject);
        if (!finalNode) {
          return this._ok("ask", { answer: "Bilmiyorum", subject: finalSubject, unknown: true }, []);
        }
        const edges = this.graph.getEdges(finalSubject);
        if (edges.length === 0) {
          return this._ok("ask", { answer: "Bilmiyorum", subject: finalSubject, unknown: true }, []);
        }
        const kistlamaVar = edges.some((e) => e.kistlama && e.relation === "yapabilir");
        const allowedYapabilir = kistlamaVar ? new Set(edges.filter((e) => e.kistlama && e.relation === "yapabilir").map((e) => e.to)) : null;
        const sorted = [...edges].sort((a, b) => b.weight - a.weight);
        const evidence = [];
        const results = [];
        for (const edge of sorted) {
          if (kistlamaVar && edge.relation === "yapabilir" && !allowedYapabilir.has(edge.to))
            continue;
          evidence.push(this._edgeEvidence(edge));
          if (edge.relation === "t\xFCr") {
            if (!results.includes(edge.to))
              results.push(edge.to);
            const transitive = this._walkTransitive(edge.to, [], 2);
            for (const t of transitive) {
              if (!results.includes(t))
                results.push(t);
            }
          } else if (edge.relation === "yapabilir") {
            if (!results.includes(edge.to))
              results.push(edge.to);
          } else if (!results.includes(edge.to)) {
            results.push(edge.to);
          }
        }
        const altResult = this.alternatives(finalSubject, 2);
        const altPaths = altResult.data.paths || [];
        const altText = altPaths.length > 1 ? `
  alternatif: ${altPaths.map((p) => `[${p.type}] ${p.to}`).join(", ")}` : "";
        const answer = results.length === 0 ? "Bilmiyorum" : `${finalSubject} ${results.join(", ")}${altText}`;
        this.plugins.emit("afterAsk", { question, answer, alternatives: altPaths.length });
        return this._ok("ask", { answer, subject: finalSubject, unknown: false, alternatives: altPaths.length }, evidence);
      }
      _walkTransitive(nodeId, visited, depth) {
        if (depth <= 0 || visited.includes(nodeId))
          return [];
        visited.push(nodeId);
        const edges = this.graph.getEdges(nodeId);
        const results = [];
        for (const e of edges) {
          if (e.relation === "t\xFCr" && !visited.includes(e.to)) {
            results.push(e.to);
            results.push(...this._walkTransitive(e.to, visited, depth - 1));
          }
        }
        return results;
      }
      alternatives(subject, maxPaths = 3) {
        const normalized = this.normalizeWord(subject);
        const node = this.graph.getNode(normalized);
        if (!node) {
          return this._ok("alternatives", { subject: normalized, answer: "Bilmiyorum", paths: [] }, []);
        }
        const edges = this.graph.getEdges(normalized);
        const groups = { "t\xFCr": [], yapabilir: [], "\xF6zellik": [], benzer: [], hipotez: [] };
        for (const e of edges) {
          const g = groups[e.relation];
          if (g)
            g.push(e.to);
        }
        const paths = [];
        const usedNodes = /* @__PURE__ */ new Set([normalized]);
        const relOrder = ["t\xFCr", "yapabilir", "\xF6zellik", "benzer", "hipotez"];
        for (const rel of relOrder) {
          if (paths.length >= maxPaths)
            break;
          const targets = groups[rel] || [];
          if (targets.length === 0)
            continue;
          const sorted = targets.map((t) => {
            var _a;
            return { target: t, weight: ((_a = edges.find((e) => e.to === t && e.relation === rel)) == null ? void 0 : _a.weight) || 0.5 };
          }).sort((a, b) => b.weight - a.weight);
          const best = sorted[0];
          if (usedNodes.has(best.target))
            continue;
          const subEdges = this.graph.getEdges(best.target).filter((e) => !usedNodes.has(e.to));
          const chain = subEdges.slice(0, 2).map((e) => ({ node: e.to, rel: e.relation }));
          paths.push({
            type: rel,
            from: normalized,
            to: best.target,
            chain,
            confidence: best.weight
          });
          usedNodes.add(best.target);
        }
        let answer = normalized + " i?in alternatif ??z?mler:\n";
        for (const p of paths) {
          answer += `  [${p.type}] ${p.from} ? ${p.to}`;
          if (p.chain.length > 0) {
            answer += ` ? ${p.chain.map((c) => c.node + "(" + c.rel + ")").join(", ")}`;
          }
          answer += ` (g?ven: ${p.confidence.toFixed(2)})
`;
        }
        if (paths.length === 0)
          answer = "Bilmiyorum";
        const evidence = paths.map((p) => ({
          kind: "alternative_path",
          text: `${p.from} --[${p.type}]--> ${p.to}`,
          confidence: p.confidence,
          nodes: [p.from, p.to],
          edges: [{ from: p.from, to: p.to, relation: p.type }]
        }));
        return this._ok("alternatives", { subject: normalized, answer, paths }, evidence);
      }
      contextSimilarity(a, b, context) {
        const ctxWeight = {};
        const ctxNode = this.graph.getNode(context);
        if (ctxNode) {
          for (const [dim, w] of Object.entries(ctxNode.vector)) {
            ctxWeight[dim] = w;
          }
        }
        const aNode = this.graph.getNode(a);
        const bNode = this.graph.getNode(b);
        if (!aNode || !bNode)
          return 0;
        const dims = /* @__PURE__ */ new Set([
          ...Object.keys(aNode.vector),
          ...Object.keys(bNode.vector),
          ...Object.keys(ctxWeight)
        ]);
        let dot = 0, magA = 0, magB = 0;
        for (const d of dims) {
          const cw = ctxWeight[d] || 1;
          const va = (aNode.vector[d] || 0) * cw;
          const vb = (bNode.vector[d] || 0) * cw;
          dot += va * vb;
          magA += va * va;
          magB += vb * vb;
        }
        const mag = Math.sqrt(magA) * Math.sqrt(magB);
        return mag === 0 ? 0 : dot / mag;
      }
      entropy() {
        const allNodes = Object.values(this.graph._nodes);
        if (allNodes.length === 0)
          return 0;
        let totalWeight = 0;
        const weights = [];
        for (const node of allNodes) {
          const edges = this.graph.getEdges(node.id);
          for (const e of edges) {
            weights.push(e.weight);
            totalWeight += e.weight;
          }
        }
        if (totalWeight === 0)
          return 0;
        let s = 0;
        for (const w of weights) {
          const p = w / totalWeight;
          s -= p * Math.log(p);
        }
        return s;
      }
      detectGaps() {
        const allNodes = Object.values(this.graph._nodes);
        const gaps = [];
        for (const node of allNodes) {
          const edges = this.graph.getEdges(node.id);
          if (edges.length === 0) {
            gaps.push(node.id);
          }
        }
        return gaps;
      }
      reason(subject) {
        const normalized = this.normalizeWord(subject);
        const node = this.graph.getNode(normalized);
        if (!node) {
          return this._ok("reason", {
            subject: normalized,
            answer: "Bilmiyorum",
            forward: [],
            backward: [],
            cycles: []
          }, []);
        }
        const ileri = this._forwardChain(normalized, [], /* @__PURE__ */ new Set(), 4);
        const geri = this._backwardChain(normalized, [], /* @__PURE__ */ new Set(), 4);
        const cycle = this._detectCycle(normalized, /* @__PURE__ */ new Set(), []);
        const evidence = [
          ...ileri.map((edge) => this._edgeEvidence(edge, "path", 0.5)),
          ...geri.map((edge) => this._edgeEvidence(edge, "path", 0.5))
        ];
        let answer = normalized + ":";
        if (ileri.length > 0)
          answer += "\n  neden olur: " + ileri.map((e) => e.to + " [" + e.relation + "]").join(", ");
        if (geri.length > 0)
          answer += "\n  nedeni: " + geri.map((e) => e.from + " [" + e.relation + "]").join(", ");
        if (cycle) {
          answer += "\n  ? d\xF6ng\xFC tespit edildi: " + cycle.join(" ? ");
          evidence.push(this._pathEvidence(cycle, "path", 0.4));
          const nedenOnce = this._resolveCycleOrder(cycle);
          if (nedenOnce)
            answer += "\n  ? ilk neden: " + nedenOnce;
        }
        return this._ok("reason", {
          subject: normalized,
          answer: answer || "Bilmiyorum",
          forward: ileri.map((edge) => this._edgeRef(edge)),
          backward: geri.map((edge) => this._edgeRef(edge)),
          cycles: cycle ? [cycle] : []
        }, evidence);
      }
      compare(a, b) {
        const na = this.graph.getNode(this.normalizeWord(a));
        const nb = this.graph.getNode(this.normalizeWord(b));
        if (!na || !nb) {
          return this._ok("compare", {
            a: this.normalizeWord(a),
            b: this.normalizeWord(b),
            answer: "Bilmiyorum",
            common: [],
            onlyA: [],
            onlyB: [],
            paths: []
          }, []);
        }
        const aN = na.id;
        const bN = nb.id;
        const aEdges = this.graph.getEdges(aN);
        const bEdges = this.graph.getEdges(bN);
        const aSet = new Set(aEdges.map((e) => e.to + "|" + e.relation));
        const bSet = new Set(bEdges.map((e) => e.to + "|" + e.relation));
        const ortak = aEdges.filter((e) => bSet.has(e.to + "|" + e.relation));
        const aFark = aEdges.filter((e) => !bSet.has(e.to + "|" + e.relation));
        const bFark = bEdges.filter((e) => !aSet.has(e.to + "|" + e.relation));
        const foundPath = this._findPath(aN, bN, /* @__PURE__ */ new Set(), [], 5);
        const evidence = [
          ...ortak.map((edge) => this._edgeEvidence(edge)),
          ...aFark.map((edge) => this._edgeEvidence(edge, "partial_match", 0.35)),
          ...bFark.map((edge) => this._edgeEvidence(edge, "partial_match", 0.35))
        ];
        if (foundPath)
          evidence.push(this._pathEvidence(foundPath, "path", 0.5));
        let answer = "?? " + aN + " vs " + bN + ":";
        if (ortak.length > 0)
          answer += "\n  ortak: " + ortak.map((e) => e.to + " [" + e.relation + "]").join(", ");
        if (aFark.length > 0)
          answer += "\n  sadece " + aN + ": " + aFark.map((e) => e.to + " [" + e.relation + "]").join(", ");
        if (bFark.length > 0)
          answer += "\n  sadece " + bN + ": " + bFark.map((e) => e.to + " [" + e.relation + "]").join(", ");
        if (foundPath)
          answer += "\n  ba?lant?: " + foundPath.join(" ? ");
        return this._ok("compare", {
          a: aN,
          b: bN,
          answer,
          common: ortak.map((edge) => this._edgeRef(edge)),
          onlyA: aFark.map((edge) => this._edgeRef(edge)),
          onlyB: bFark.map((edge) => this._edgeRef(edge)),
          paths: foundPath ? [foundPath] : []
        }, evidence);
      }
      _parseNumericComparison(text) {
        const raw = String(text || "").trim();
        if (!raw)
          return null;
        const match = raw.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*(==|=|!=|<>|≠|<=|>=|<|>)\s*(-?\d+(?:[.,]\d+)?)\s*$/);
        if (!match)
          return null;
        const left = Number(String(match[1]).replace(",", "."));
        const operator = match[2];
        const right = Number(String(match[3]).replace(",", "."));
        if (!Number.isFinite(left) || !Number.isFinite(right))
          return null;
        let ok = false;
        switch (operator) {
          case "=":
          case "==":
            ok = left === right;
            break;
          case "!=":
          case "<>":
          case "\u2260":
            ok = left !== right;
            break;
          case "<":
            ok = left < right;
            break;
          case ">":
            ok = left > right;
            break;
          case "<=":
            ok = left <= right;
            break;
          case ">=":
            ok = left >= right;
            break;
          default:
            return null;
        }
        return {
          ok,
          left,
          operator,
          right,
          text: raw
        };
      }
      _forwardChain(id, chain, visited, depth) {
        if (depth <= 0 || visited.has(id))
          return chain;
        visited.add(id);
        const edges = this.graph.getEdges(id);
        for (const e of edges) {
          if (!visited.has(e.to) && !chain.some((c) => c.to === e.to)) {
            chain.push(e);
            this._forwardChain(e.to, chain, visited, depth - 1);
          }
        }
        return chain;
      }
      _backwardChain(id, chain, visited, depth) {
        if (depth <= 0 || visited.has(id))
          return chain;
        visited.add(id);
        const inEdges = this.graph.getInEdges(id);
        for (const e of inEdges) {
          if (!visited.has(e.from) && !chain.some((c) => c.from === e.from)) {
            chain.push(e);
            this._backwardChain(e.from, chain, visited, depth - 1);
          }
        }
        return chain;
      }
      _detectCycle(start, visited, pathArr) {
        if (visited.has(start)) {
          const idx = pathArr.indexOf(start);
          if (idx >= 0)
            return pathArr.slice(idx).concat(start);
          return null;
        }
        visited.add(start);
        pathArr.push(start);
        const edges = this.graph.getEdges(start);
        for (const e of edges) {
          const result = this._detectCycle(e.to, visited, [...pathArr]);
          if (result)
            return result;
        }
        const inEdges = this.graph.getInEdges(start);
        for (const e of inEdges) {
          if (!visited.has(e.from)) {
            const result = this._detectCycle(e.from, visited, [...pathArr]);
            if (result)
              return result;
          }
        }
        return null;
      }
      _resolveCycleOrder(cycle) {
        const giren = /* @__PURE__ */ new Set();
        const cikan = /* @__PURE__ */ new Set();
        for (let i = 0; i < cycle.length - 1; i++) {
          const edges = this.graph.getEdges(cycle[i]);
          for (const e of edges) {
            if (e.to === cycle[i + 1] && e.relation === "t\xFCr") {
              cikan.add(cycle[i]);
              giren.add(cycle[i + 1]);
            }
          }
        }
        for (const n of cycle) {
          if (cikan.has(n) && !giren.has(n))
            return n + " (temel t\xFCr)";
        }
        return null;
      }
      _findPath(from, to, visited, pathArr, depth) {
        if (depth <= 0 || visited.has(from))
          return null;
        visited.add(from);
        pathArr.push(from);
        if (from === to)
          return [...pathArr];
        const edges = this.graph.getEdges(from);
        for (const e of edges) {
          const result = this._findPath(e.to, to, visited, [...pathArr], depth - 1);
          if (result)
            return result;
        }
        const inEdges = this.graph.getInEdges(from);
        for (const e of inEdges) {
          const result = this._findPath(e.from, to, visited, [...pathArr], depth - 1);
          if (result)
            return result;
        }
        return null;
      }
      // --- Background auto-think ---
      startAutoThink(intervalMs = 1e4) {
        if (this._thinkTimer)
          return;
        this._dreamer = new Dream(this);
        this._thinkTimer = setInterval(() => {
          try {
            this._autoThinkTick();
          } catch (e) {
            console.error("\n[autoThink hata]", e.message);
          }
        }, intervalMs);
        this._autoThinkLog("AutoThink ba?lad? (her " + intervalMs / 1e3 + "s)");
      }
      stopAutoThink() {
        if (this._thinkTimer) {
          clearInterval(this._thinkTimer);
          this._thinkTimer = null;
        }
        this._autoThinkLog("AutoThink durduruldu");
      }
      _autoThinkTick() {
        if (!this._dreamCount)
          this._dreamCount = 0;
        this._dreamCount++;
        const isBilinclikTick = this._dreamCount > 0;
        const hips = this._dreamer.dream();
        let eklenen = 0;
        if (hips.length > 0) {
          for (const h of hips.slice(0, 5)) {
            if (h.confidence > 0.25) {
              const existing = this.graph.hasAnyEdge(h.from, h.to);
              if (!existing && this.graph.getNode(h.from) && this.graph.getNode(h.to)) {
                const rel = h.type === "zincir" ? "benzer" : h.type === "benzerlik" ? "benzer" : h.relation === "t\xFCr" ? "t\xFCr" : h.relation === "yapabilir" ? "yapabilir" : h.relation === "\xF6zellik" ? "\xF6zellik" : "hipotez";
                this.graph.addEdge(h.from, h.to, rel);
                eklenen++;
              }
            }
          }
        }
        let celiskiSayisi = 0;
        let metaGuven = 0.5;
        if (isBilinclikTick && this._dreamCount % 3 === 0) {
          const durum = this.introspect().data;
          celiskiSayisi = durum.saglik.celiski;
          metaGuven = durum.saglik.metaGuven;
          if (celiskiSayisi > 5) {
            this._autoThinkLog(durum.zayifNoktalar.join("; "));
          }
        }
        if (eklenen > 0) {
          this._autoThinkLog(eklenen + " yeni ba\xC4\u0178lant? - toplam " + Object.keys(this.graph._nodes).length + " d?\xC4\u0178?m");
        } else if (this._dreamCount % 5 === 0) {
          this._autoThinkLog("bo? r?ya, daha fazla bilgi laz?m");
        }
      }
      _autoThinkLog(msg) {
        console.log("\n[\u011F\u0178\xA7\xA0 " + (/* @__PURE__ */ new Date()).toLocaleTimeString() + "] " + msg);
      }
      /**
       * Bir ifadeyi bilgi grafiÄŸiyle doÄŸrula.
       * "kedi bal?k yer" ? ?zne=kedi, nesne=bal?k yer ? kenar var m??
       */
      verify(statement) {
        var _a, _b;
        const numericComparison = this._parseNumericComparison(statement);
        if (numericComparison) {
          return this._ok("verify", {
            status: numericComparison.ok ? "dogrulandi" : "celiski",
            confidence: 0.98
          }, [{
            kind: numericComparison.ok ? "direct_edge" : "contradiction",
            text: `Say\u0131sal kar\u015F\u0131la\u015Ft\u0131rma: "${numericComparison.left} ${numericComparison.operator} ${numericComparison.right}"`,
            confidence: 0.98,
            nodes: [String(numericComparison.left), String(numericComparison.right)],
            edges: []
          }]);
        }
        const parts = statement.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          return this._ok("verify", { status: "bilinmiyor", confidence: 0 }, []);
        }
        const subject = this.normalizeWord(parts[0]);
        const subjectNode = this.graph.getNode(subject);
        if (!subjectNode) {
          return this._ok("verify", { status: "bilinmiyor", confidence: 0 }, []);
        }
        const edges = this.graph.getEdges(subject);
        const predicate = parts.slice(1).join(" ");
        const predicateNumericComparison = this._parseNumericComparison(predicate);
        if (predicateNumericComparison) {
          return this._ok("verify", {
            status: predicateNumericComparison.ok ? "dogrulandi" : "celiski",
            confidence: 0.95
          }, [{
            kind: predicateNumericComparison.ok ? "direct_edge" : "contradiction",
            text: `Say\u0131sal kar\u015F\u0131la\u015Ft\u0131rma: "${predicateNumericComparison.left} ${predicateNumericComparison.operator} ${predicateNumericComparison.right}"`,
            confidence: 0.95,
            nodes: [subject, String(predicateNumericComparison.left), String(predicateNumericComparison.right)],
            edges: []
          }]);
        }
        const negMatch = predicate.match(/^(.*?)\s+(de[ğg]il|de[ğg]ildir|not)\s*$/i);
        if (negMatch) {
          const positive = negMatch[1].trim();
          if (positive) {
            const posNorm = this.normalizeWord(positive);
            const posEdge = edges.find((e) => e.to === posNorm || e.to.includes(posNorm));
            if (posEdge) {
              return this._ok("verify", { status: "celiski", confidence: 0.85 }, [{
                kind: "contradiction",
                text: `${subject} --[${posEdge.relation}]--> ${posEdge.to} var ama ifade olumsuz: "${predicate}"`,
                confidence: 0.85,
                nodes: [subject, posEdge.to],
                edges: [{ from: subject, to: posEdge.to, relation: posEdge.relation }]
              }]);
            }
          }
        }
        const directEdge = edges.find((e) => predicate.includes(e.to) || e.to === predicate);
        if (directEdge) {
          const confidence = Math.min(0.95, ((_b = (_a = directEdge.confidence) != null ? _a : directEdge.weight) != null ? _b : 0.5) + 0.4);
          return this._ok("verify", { status: "dogrulandi", confidence }, [this._edgeEvidence(directEdge, "direct_edge", confidence)]);
        }
        const cons = this.detectContradictions();
        const subjCons = cons.filter((c) => c.node === subject);
        if (subjCons.length > 0) {
          const evidence = subjCons.map((c) => this._contradictionEvidence(c));
          return this._ok("verify", { status: "celiski", confidence: 0.7 }, evidence);
        }
        const rawTarget = parts[parts.length - 1];
        const cleanTarget = rawTarget.replace(/(d\u0131r|dir|dur|d\u00fcr|t\u0131r|tir|tur|t\u00fcr)$/i, "");
        const target = this.normalizeWord(cleanTarget || rawTarget);
        if (target !== subject) {
          const foundPath = this._findPath(subject, target, /* @__PURE__ */ new Set(), [], 4);
          if (foundPath) {
            return this._ok("verify", { status: "dogrulandi", confidence: 0.5 }, [this._pathEvidence(foundPath, "path", 0.5)]);
          }
        }
        const stmtNums = predicate.match(/\d+/g);
        if (stmtNums && edges.length > 0) {
          for (const edge of edges) {
            const edgeNums = String(edge.to).match(/\d+/g);
            if (edgeNums) {
              const mismatch = stmtNums.some((n, i) => edgeNums[i] && n !== edgeNums[i]);
              if (mismatch) {
                const stmtWords = parts.slice(1).filter((p) => !/^\d+$/.test(p) && p.length > 1);
                const hasTextOverlap = stmtWords.some((w) => edge.to.includes(w));
                if (hasTextOverlap) {
                  return this._ok("verify", { status: "celiski", confidence: 0.75 }, [{
                    kind: "contradiction",
                    text: `Say\u0131sal \xE7eli\u015Fki: "${predicate}" ifadesinde ${stmtNums.join(",")} ama "${edge.to}" bilgisinde ${edgeNums.join(",")}`,
                    confidence: 0.75,
                    nodes: [subject, edge.to],
                    edges: [{ from: subject, to: edge.to, relation: edge.relation }]
                  }]);
                }
              }
            }
          }
        }
        for (const word of parts.slice(1)) {
          const w = this.normalizeWord(word);
          const match = edges.find((e) => e.to === w || e.to.includes(w));
          if (match) {
            return this._ok("verify", { status: "dogrulandi", confidence: 0.35 }, [this._edgeEvidence(match, "partial_match", 0.35)]);
          }
        }
        return this._ok("verify", { status: "bilinmiyor", confidence: 0 }, []);
      }
      dream(opts = {}) {
        var _a;
        const dreamer = new Dream(this);
        const raw = dreamer.dream(opts);
        const hypotheses = raw.map((h) => {
          const nodes = [h.from, h.to, h.node, ...h.targets || []].filter(Boolean);
          const edges = h.from && h.to ? [{ from: h.from, to: h.to, relation: h.relation || h.type || "hypothesis" }] : [];
          return {
            ...h,
            _evidence: {
              kind: "hypothesis",
              text: h.from && h.to ? `${h.from} ? ${h.to}` : `${nodes.join(" ? ") || "hypothesis"}`,
              confidence: Math.max(0, Math.min(1, h.confidence || 0)),
              nodes,
              edges
            }
          };
        });
        const learned = [];
        if (opts.learnFromDream) {
          const threshold = (_a = opts.dreamLearnThreshold) != null ? _a : 0.1;
          for (const h of hypotheses) {
            if (h.confidence > threshold && h.from && h.to) {
              const existing = this.graph.hasAnyEdge(h.from, h.to);
              if (!existing && this.graph.getNode(h.from) && this.graph.getNode(h.to)) {
                const rel = h.relation === "t\xFCr" || h.via === "t\xFCr" ? "t\xFCr" : h.relation === "yapabilir" ? "yapabilir" : h.relation === "\xF6zellik" ? "\xF6zellik" : h.type === "zincir" || h.relation === "benzer" ? "benzer" : "hipotez";
                this.graph.addEdge(h.from, h.to, rel);
                learned.push({ from: h.from, to: h.to, confidence: h.confidence, relation: rel });
              }
            }
          }
        }
        if (!this._dreamCount)
          this._dreamCount = 0;
        this._dreamCount++;
        const evidence = hypotheses.map((h) => h._evidence);
        return this._ok("dream", { hypotheses, learned, cycle: this._dreamCount }, evidence);
      }
      learnDocument(text) {
        const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 3 && !l.startsWith("#") && !l.startsWith("//"));
        let count = 0;
        for (const line of lines) {
          const cleaned = line.replace(/^[\s-â€“â€”*â€¢]+/, "").trim();
          const words = cleaned.split(/\s+/);
          if (words.length >= 2) {
            this.learn(cleaned);
            count++;
          }
        }
        return count;
      }
      /**
       * LLM yan?t?ndan bilgi ?ÄŸren.
       * Ã‡eli?kili c?mleleri atlar, yeni bilgileri grafiÄŸe ekler.
       *
       * @param {string} text - LLM'den gelen ham metin
       * @param {object} [opts]
       * @param {boolean} [opts.skipConflicts=true]  - çelişkili c?mleleri atla
       * @param {number}  [opts.minWords=2]           - minimum kelime say?s?
       * @param {number}  [opts.maxSentences=20]      - max c?mle say?s?
       * @returns {{ learned: number, skipped: number, conflicts: string[] }}
       */
      learnFromLLM(text, opts = {}) {
        if (this.paranoidMode) {
          return {
            learned: 0,
            skipped: 0,
            conflicts: [],
            ok: false,
            error: {
              code: AXIOM_ERROR.LLM_DISABLED,
              message: "Paranoid mode aktif: d?? LLM ?a\xC4\u0178r?lar? ve otomatik ?\xC4\u0178renme engellendi."
            },
            meta: {
              contractVersion: this.contractVersion,
              paranoidMode: this.paranoidMode
            }
          };
        }
        const skipConflicts = opts.skipConflicts !== false;
        const minWords = opts.minWords || 2;
        const maxSentences = opts.maxSentences || 20;
        const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => s.length > 3);
        let learned = 0, skipped = 0;
        const conflicts = [];
        for (const sentence of sentences.slice(0, maxSentences)) {
          const cleaned = sentence.replace(/^[\s#*\-â€“â€”â€¢>]+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1").trim();
          const words = cleaned.split(/\s+/).filter(Boolean);
          if (words.length < minWords) {
            skipped++;
            continue;
          }
          if (skipConflicts) {
            const check = this.verify(cleaned);
            if (check.data.status === "celiski") {
              conflicts.push(cleaned);
              skipped++;
              continue;
            }
          }
          this.learn(cleaned);
          learned++;
        }
        return { learned, skipped, conflicts };
      }
      detectContradictions() {
        const allNodes = Object.values(this.graph._nodes);
        const contradictions = [];
        for (const node of allNodes) {
          const edges = this.graph.getEdges(node.id);
          const typeEdges = edges.filter((e) => e.relation === "t\xFCr");
          if (typeEdges.length > 1) {
            contradictions.push({
              type: "\xE7oklu-t\xFCr",
              node: node.id,
              targets: typeEdges.map((e) => e.to),
              confidence: Math.min(0.6, typeEdges.length * 0.15),
              edges: typeEdges,
              message: `"${node.id}" birden fazla tur bilgisi tasiyor: ${typeEdges.map((e) => e.to).join(", ")}`
            });
          }
        }
        for (const node of allNodes) {
          const nodeEdges = this.graph.getEdges(node.id);
          for (const edge of nodeEdges) {
            if (edge.relation !== "t\xFCr")
              continue;
            const backEdge = this.graph.getEdge(edge.to, node.id, "t\xFCr");
            if (backEdge) {
              if (!contradictions.some((c) => c.type === "d\xF6ng\xFC" && c.node === node.id)) {
                contradictions.push({
                  type: "d\xF6ng\xFC",
                  node: node.id,
                  targets: [edge.to],
                  confidence: 0.7,
                  edges: [edge, backEdge],
                  message: `"${node.id}" ve "${edge.to}" karsilikli tur iliskisi kuruyor`
                });
              }
            }
          }
        }
        for (const node of allNodes) {
          const edges = this.graph.getEdges(node.id);
          const degilEdges = edges.filter((e) => e.relation === "de\u011Fil");
          if (degilEdges.length === 0)
            continue;
          const otherEdges = edges.filter((e) => e.relation !== "de\u011Fil" && e.relation !== "benzer" && e.relation !== "hipotez");
          for (const degil of degilEdges) {
            const degilCore = degil.to.replace(/(?:maz|mez|mamak|memek|değildir|değil)$/i, "").trim();
            for (const other of otherEdges) {
              const otherCore = other.to.replace(/(?:maz|mez|mamak|memek|değildir|değil|yapabilir|yapamaz|edebilir|edemez)$/i, "").trim();
              if (degilCore.length > 3 && otherCore.length > 3 && (otherCore.includes(degilCore.slice(0, 8)) || degilCore.includes(otherCore.slice(0, 8)))) {
                contradictions.push({
                  type: "negasyon",
                  node: node.id,
                  targets: [degil.to, other.to],
                  confidence: 0.8,
                  message: `"${node.id}" i\xE7in "${degil.to}" (de\u011Fil) ile "${other.to}" (${other.relation}) \xE7eli\u015Fiyor`,
                  edges: [degil, other]
                });
              }
            }
          }
        }
        for (const node of allNodes) {
          const edges = this.graph.getEdges(node.id);
          const edgesWithNums = [];
          for (const e of edges) {
            if (e.relation === "hipotez")
              continue;
            const nums = this._extractNumbers(e.to);
            if (nums)
              edgesWithNums.push({ edge: e, nums });
          }
          if (edgesWithNums.length < 2)
            continue;
          for (let i = 0; i < edgesWithNums.length; i++) {
            for (let j = i + 1; j < edgesWithNums.length; j++) {
              if (edgesWithNums[i].nums === edgesWithNums[j].nums)
                continue;
              const coreI = this._getTextCore(edgesWithNums[i].edge.to);
              const coreJ = this._getTextCore(edgesWithNums[j].edge.to);
              const normI = coreI.replace(/\s+/g, " ");
              const normJ = coreJ.replace(/\s+/g, " ");
              const shorter = normI.length <= normJ.length ? normI : normJ;
              const longer = normI.length <= normJ.length ? normJ : normI;
              if (shorter.length < 5)
                continue;
              if (!longer.includes(shorter))
                continue;
              contradictions.push({
                type: "say\u0131sal",
                node: node.id,
                targets: [edgesWithNums[i].edge.to, edgesWithNums[j].edge.to],
                confidence: 0.75,
                message: `"${node.id}" i\xE7in say\u0131sal \xE7eli\u015Fki: ${edgesWithNums[i].nums} vs ${edgesWithNums[j].nums}`,
                edges: [edgesWithNums[i].edge, edgesWithNums[j].edge]
              });
            }
          }
        }
        for (const node of allNodes) {
          const edges = this.graph.getEdges(node.id);
          for (const e of edges) {
            if (e.relation === "benzer" || e.relation === "hipotez")
              continue;
            if (e.celiski || e.weight !== void 0 && e.weight < 0.3) {
              contradictions.push({
                type: "d\xFC\u015F\xFCk-a\u011F\u0131rl\u0131k",
                node: node.id,
                targets: [e.to],
                confidence: 0.6,
                message: e.celiski ? `"${node.id}" --[${e.relation}]--> "${e.to}" \xE7eli\u015Fki nedeniyle d\xFC\u015F\xFCr\xFCld\xFC (weight: ${e.weight})` : `"${node.id}" --[${e.relation}]--> "${e.to}" d\xFC\u015F\xFCk g\xFCven (weight: ${e.weight})`,
                edges: [e]
              });
            }
          }
        }
        return contradictions;
      }
      _extractNumbers(text) {
        const turkishNums = {
          "bir": 1,
          "iki": 2,
          "uc": 3,
          "dort": 4,
          "bes": 5,
          "alti": 6,
          "yedi": 7,
          "sekiz": 8,
          "dokuz": 9,
          "on": 10,
          "yirmi": 20,
          "otuz": 30,
          "kirk": 40,
          "elli": 50,
          "altmis": 60,
          "yetmis": 70,
          "seksen": 80,
          "doksan": 90,
          "yuz": 100,
          "bin": 1e3
        };
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        const nums = [];
        for (const w of words) {
          if (/^\d+$/.test(w))
            nums.push(parseInt(w, 10));
          else if (turkishNums[w] !== void 0)
            nums.push(turkishNums[w]);
        }
        const digitMatches = text.match(/\d+/g);
        if (digitMatches)
          for (const d of digitMatches)
            nums.push(Number(d));
        if (nums.length === 0)
          return null;
        return [...new Set(nums)].sort((a, b) => a - b).join(",");
      }
      _getTextCore(text) {
        const turkishNums = {
          "bir": 1,
          "iki": 2,
          "uc": 3,
          "dort": 4,
          "bes": 5,
          "alti": 6,
          "yedi": 7,
          "sekiz": 8,
          "dokuz": 9,
          "on": 10,
          "yirmi": 20,
          "otuz": 30,
          "kirk": 40,
          "elli": 50,
          "altmis": 60,
          "yetmis": 70,
          "seksen": 80,
          "doksan": 90,
          "yuz": 100,
          "bin": 1e3
        };
        let s = text.toLowerCase();
        for (const [word, num] of Object.entries(turkishNums)) {
          s = s.replace(new RegExp(`\\b${word}\\b`, "g"), String(num));
        }
        return s.replace(/\d+/g, "").replace(/\s+/g, " ").trim();
      }
      introspect() {
        this.plugins.emit("beforeIntrospect", {});
        const allNodes = Object.values(this.graph._nodes);
        const allEdges = allNodes.flatMap((n) => this.graph.getEdges(n.id));
        const inEdges = allNodes.flatMap((n) => this.graph.getInEdges(n.id));
        const nodeCount = allNodes.length;
        const edgeCount = allEdges.length;
        const typeEdges = allEdges.filter((e) => e.relation === "t\xFCr").length;
        const canEdges = allEdges.filter((e) => e.relation === "yapabilir").length;
        const ozellikEdges = allEdges.filter((e) => e.relation === "\xF6zellik").length;
        const benzerEdges = allEdges.filter((e) => e.relation === "benzer").length;
        const hipotezEdges = allEdges.filter((e) => e.relation === "hipotez").length;
        const yalitilmis = allNodes.filter((n) => {
          const out = this.graph.getEdges(n.id);
          const inn = this.graph.getInEdges(n.id);
          return out.length === 0 && inn.length === 0;
        }).map((n) => n.id);
        const celiskiler = this.detectContradictions();
        const bosluklar = this.detectGaps();
        const agirliklar = allEdges.map((e) => e.weight || 0.5);
        const ortAgirlik = agirliklar.length > 0 ? agirliklar.reduce((s, w) => s + w, 0) / agirliklar.length : 0;
        const dusukAgirlik = agirliklar.filter((w) => w < 0.3).length;
        const selfNodes = ["axiom", "kernel", "dream", "r?ya", "hipotez"];
        const selfBilgi = {};
        for (const n of selfNodes) {
          const node = this.graph.getNode(n);
          if (node) {
            const edges = this.graph.getEdges(n);
            selfBilgi[n] = { var: true, kenar: edges.length };
          } else {
            selfBilgi[n] = { var: false, kenar: 0 };
          }
        }
        const dreamCycle = this._dreamCount || 0;
        const entropi = this.entropy();
        let metaGuven = 0.5;
        if (nodeCount > 0) {
          metaGuven += Math.min(0.2, nodeCount * 1e-3);
          metaGuven -= Math.min(0.3, celiskiler.length * 0.05);
          metaGuven += Math.min(0.1, ortAgirlik * 0.1);
          metaGuven -= Math.min(0.1, yalitilmis.length * 0.02);
          metaGuven = Math.max(0, Math.min(1, metaGuven));
        }
        const zayifNoktalar = [];
        if (yalitilmis.length > 0)
          zayifNoktalar.push(`${yalitilmis.length} yal?t?lm?? d?\xC4\u0178?m`);
        if (celiskiler.length > 0)
          zayifNoktalar.push(`${celiskiler.length} \xE7eli\u015Fki`);
        if (dusukAgirlik > edgeCount * 0.3)
          zayifNoktalar.push(`${dusukAgirlik} d?k g?venli kenar`);
        if (nodeCount < 5)
          zayifNoktalar.push("?ok az bilgi");
        const gucluNoktalar = [];
        if (nodeCount > 50)
          gucluNoktalar.push("geni? bilgi grafi\xC4\u0178i");
        if (typeEdges > 10)
          gucluNoktalar.push("g??l? t\xFCr hiyerar?isi");
        if (benzerEdges > 5)
          gucluNoktalar.push("aktif benzerlik a\xC4\u0178?");
        if (dreamCycle > 0)
          gucluNoktalar.push(`${dreamCycle} r?ya d\xF6ng\xFCs? tamamland?`);
        const result = {
          bilgi: {
            dugum: nodeCount,
            kenar: edgeCount,
            tur: typeEdges,
            yapabilir: canEdges,
            ozellik: ozellikEdges,
            benzer: benzerEdges,
            hipotez: hipotezEdges,
            yalitilmis: yalitilmis.length,
            entropi: entropi.toFixed(3)
          },
          saglik: {
            metaGuven: parseFloat(metaGuven.toFixed(3)),
            celiski: celiskiler.length,
            bosluk: bosluklar.length,
            ortalamaAgirlik: parseFloat(ortAgirlik.toFixed(3)),
            dusukGuvenliKenar: dusukAgirlik
          },
          ozBilgi: selfBilgi,
          zayifNoktalar,
          gucluNoktalar,
          dreamCycle
        };
        this.plugins.emit("afterIntrospect", result);
        return this._ok("introspect", result);
      }
      consolidate(dryRun = true) {
        const edges = this.graph._edges;
        const removed = [];
        const marked = /* @__PURE__ */ new Set();
        const byPair = {};
        for (let i = 0; i < edges.length; i++) {
          if (edges[i].kistlama)
            continue;
          const key = `${edges[i].from}|${edges[i].to}`;
          if (!byPair[key])
            byPair[key] = [];
          byPair[key].push(i);
        }
        for (const [, indices] of Object.entries(byPair)) {
          const high = indices.filter((i) => edges[i].weight >= 0.5);
          const low = indices.filter((i) => edges[i].weight < 0.3);
          for (const li of low) {
            if (high.length > 0) {
              removed.push({
                idx: li,
                edge: edges[li],
                reason: `low-weight (${edges[li].weight}) superseded by high-weight (${edges[high[0]].weight}) for same pair`
              });
              marked.add(li);
            }
          }
        }
        const byRel = {};
        for (let i = 0; i < edges.length; i++) {
          if (marked.has(i) || edges[i].kistlama)
            continue;
          const key = `${edges[i].from}|${edges[i].relation}`;
          if (!byRel[key])
            byRel[key] = [];
          byRel[key].push(i);
        }
        for (const [, indices] of Object.entries(byRel)) {
          const high = indices.filter((i) => edges[i].weight >= 0.5);
          const low = indices.filter((i) => edges[i].weight < 0.3);
          for (const li of low) {
            if (high.length > 0 && !marked.has(li)) {
              removed.push({
                idx: li,
                edge: edges[li],
                reason: `low-weight restriction (${edges[li].weight}) \xE2\u20AC\u201D subject already has high-weight '${edges[li].relation}'`
              });
              marked.add(li);
            }
          }
        }
        if (!dryRun && removed.length > 0) {
          this.graph._edges = edges.filter((_, i) => !marked.has(i));
          this.graph._rebuildIndex();
          try {
            this.graph.save();
          } catch (_) {
          }
        }
        return {
          dryRun,
          removed: removed.length,
          details: removed.map(
            (r) => `${r.edge.from} ? ${r.edge.to} (${r.edge.relation}, w:${r.edge.weight}): ${r.reason}`
          )
        };
      }
      /**
       * Kendi kendine evrimle?me döngüs?.
       * 1. R?ya g?r (hipotez ?ret)
       * 2. Y?ksek g?venli hipotezleri bilgiye d?n??tür
       * 3. GrafiÄŸi temizle (birle?tir + optimize et)
       * 4. Kaydet, rapor d?ndır
       */
      selfEvolve(opts = {}) {
        const Dream2 = require_dream();
        const dreamer = new Dream2(this);
        const dreams = dreamer.dream();
        const added = [];
        for (const h of dreams) {
          if (opts.minConfidence && h.confidence < opts.minConfidence)
            continue;
          const defaultMin = h.type === "zincir" ? 0.25 : 0.3;
          if (h.confidence < defaultMin)
            continue;
          const rel = h.relation || (h.type === "benzerlik" || h.type === "vekt\xFCr-benzerlik" ? "benzer" : h.type === "ba\xC4\u0178lant?-?nerisi" ? "hipotez" : "hipotez");
          const existing = this.graph.getEdge(h.from, h.to, rel);
          if (existing)
            continue;
          const weight = Math.min(0.4, h.confidence * 0.8);
          this.graph.addEdge(h.from, h.to, rel, { weight, source: "kendilik" });
          added.push({ from: h.from, to: h.to, relation: rel, confidence: h.confidence, type: h.type });
        }
        const cons = this.consolidate(false);
        const opt = this.graph.optimize();
        if (added.length > 0 || cons.removed > 0) {
          try {
            this.graph.save();
          } catch (_) {
          }
        }
        this._dreamCount = (this._dreamCount || 0) + 1;
        return {
          dreams: dreams.length,
          added: added.length,
          addedDetails: added,
          consolidated: cons.removed,
          optimized: opt.pruned
        };
      }
      /**
       * Kendi kendine ?ÄŸrenme â€” bo?luklar? tespit edip doldurur.
       * Bilinmeyen kavramlar? bulur ve LLM'den ?ÄŸrenir.
       */
      selfLearn(opts = {}) {
        const gaps = this.detectGaps();
        if (gaps.length === 0)
          return { gaps: 0, learned: 0, message: "Bo?luk yok" };
        const before = this.graph._edges.length;
        for (const gapId of gaps) {
          const node = this.graph.getNode(gapId);
          if (!node)
            continue;
          const hasAnyEdge = this.graph.getEdges(gapId).length > 0 || this.graph.getInEdges(gapId).length > 0;
          if (hasAnyEdge)
            continue;
          const sim = this.graph.cosineSimilarity ? this.graph.cosineSimilarity(gapId, gapId) : 0;
        }
        const after = this.graph._edges.length;
        return { gaps: gaps.length, learned: after - before };
      }
      _autoMaintain() {
        this._learnCount = (this._learnCount || 0) + 1;
        if (this._learnCount >= this.maintenanceEvery) {
          this._learnCount = 0;
          this.selfEvolve();
        }
      }
    };
    module2.exports = Kernel2;
    module2.exports.AXIOM_ERROR = AXIOM_ERROR;
    module2.exports.CONTRACT_VERSION = CONTRACT_VERSION;
  }
});

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => AxiomPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_kernel = __toESM(require_kernel());
var DEFAULT_SETTINGS = {
  memoryPath: ".obsidian/axiom-memory.json",
  lang: "tr"
};
var AxiomPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    const vaultPath = this.app.vault.getRoot().path;
    const memoryPath = `${vaultPath}${this.settings.memoryPath}`;
    this.kernel = new import_kernel.default({
      memoryPath,
      lang: this.settings.lang
    });
    this.addCommand({
      id: "axiom-learn-selection",
      name: "Learn from selection",
      editorCallback: (editor) => {
        const text = editor.getSelection();
        if (!text) {
          new import_obsidian.Notice("Select text first");
          return;
        }
        const result = this.kernel.learn(text);
        new import_obsidian.Notice(
          `\xD6\u011Frenildi: ${result.data.learned} \xF6nerme, ${result.data.conflicts.length} \xE7eli\u015Fki`
        );
      }
    });
    this.addCommand({
      id: "axiom-dream",
      name: "Dream",
      callback: () => {
        const result = this.kernel.dream({ limit: 10 });
        const h = result.data.hypotheses;
        if (h.length === 0) {
          new import_obsidian.Notice("Hi\xE7 hipotez \xFCretilmedi");
          return;
        }
        const lines = h.slice(0, 10).map(
          (x, i) => `${i + 1}. ${x.from} \u2192 ${x.to} (${(x.confidence * 100).toFixed(0)}%)`
        );
        new import_obsidian.Notice(`R\xFCya sonu\xE7lar\u0131:
${lines.join("\n")}`, 8e3);
      }
    });
    this.addCommand({
      id: "axiom-learn-note",
      name: "Learn current note",
      editorCallback: (editor) => {
        const text = editor.getValue();
        if (!text) {
          new import_obsidian.Notice("Note is empty");
          return;
        }
        const result = this.kernel.learnDocument(text);
        new import_obsidian.Notice(
          `\xD6\u011Frenildi: ${result.data.learned} \xF6nerme`
        );
      }
    });
    this.addCommand({
      id: "axiom-stats",
      name: "Show graph stats",
      callback: () => {
        const stats = this.kernel.graph.getStats();
        new import_obsidian.Notice(
          `D\xFC\u011F\xFCm: ${stats.nodes}
Kenar: ${stats.edges}
Altyap\u0131: ${stats.backend}`
        );
      }
    });
    this.addCommand({
      id: "axiom-contradictions",
      name: "Show contradictions",
      callback: () => {
        var _a;
        const result = this.kernel.detectContradictions();
        const c = ((_a = result.data) == null ? void 0 : _a.contradictions) || [];
        if (c.length === 0) {
          new import_obsidian.Notice("\xC7eli\u015Fki bulunamad\u0131");
          return;
        }
        const lines = c.slice(0, 10).map(
          (x, i) => `${i + 1}. ${x.subject}: ${x.current} \u2260 ${x.existing} (${x.type})`
        );
        new import_obsidian.Notice(`\xC7eli\u015Fkiler:
${lines.join("\n")}`, 8e3);
      }
    });
    this.addCommand({
      id: "axiom-save",
      name: "Save graph to file",
      callback: () => {
        this.kernel.graph.save();
        new import_obsidian.Notice("Grafik kaydedildi");
      }
    });
    this.addSettingTab(new AxiomSettingTab(this.app, this));
  }
  onunload() {
    this.kernel.graph.save();
  }
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var AxiomSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Axiom Ayarlar\u0131" });
    new import_obsidian.Setting(containerEl).setName("Haf\u0131za dosyas\u0131").setDesc("Vault k\xF6k\xFCne g\xF6reli yol").addText(
      (text) => text.setPlaceholder(".obsidian/axiom-memory.json").setValue(this.plugin.settings.memoryPath).onChange(async (v) => {
        this.plugin.settings.memoryPath = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Dil").setDesc("NLP dili (tr, en, auto)").addText(
      (text) => text.setPlaceholder("tr").setValue(this.plugin.settings.lang).onChange(async (v) => {
        this.plugin.settings.lang = v;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("hr");
    const stats = this.plugin.kernel.graph.getStats();
    containerEl.createEl("p", {
      text: `D\xFC\u011F\xFCm: ${stats.nodes} | Kenar: ${stats.edges} | Altyap\u0131: ${stats.backend}`
    });
  }
};
