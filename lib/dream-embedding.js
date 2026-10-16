'use strict';

/**
 * The Node2Vec embedding pass, extracted from `dream.js` so the file-size
 * ratchet (#328) does not have to choose between a fix and a budget.
 *
 * This module is deliberately free of any Dream reference: `runEmbedding`
 * receives a context of plain functions, so nothing here reaches into another
 * object's `_private` member (docs/architecture-policy.md §4). `Dream` builds
 * that context from its own `this._*` members, which stays a module using its
 * own internals and keeps the overrides `dream.test.js` installs working.
 */

const { normalizeWorkspaceId } = require('./graph-record-utils');

/**
 * Geliştirilmiş projeksiyon ağırlığı.
 * Eski _hash sadece +1/-1 döndürüyordu — bu çok kaba.
 * Şimdi Gaussian benzeri sürekli değer üretiyoruz (FNV-1a tabanlı).
 */
function projectionWeight(str, dim, totalDims) {
  // FNV-1a hash — daha iyi dağılım
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Dim'e göre farklı seed ile ikinci hash
  let h2 = h ^ (dim * 2654435761);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0x45d9f3b);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0x45d9f3b);
  h2 = h2 ^ (h2 >>> 16);

  // h2 zaten signed 32-bit aralığındadır: [-2^31, 2^31 - 1].
  // Bölme onu doğrudan [-1, 1) aralığına taşır.
  return h2 / 2147483648;
}

function nodeSignatureWeight(graph, node, dim, totalDims, workspaceId = 'default') {
  const edges = graph.getEdges(node.id, workspaceId);
  const inEdges = graph.getInEdges(node.id, workspaceId);
  const label = String(node.label || node.id || '');
  const relationProfile = edges
    .map(e => `${e.relation}:${e.to}`)
    .sort()
    .join('|');
  const seed = [
    `id:${node.id}`,
    `label:${label}`,
    `deg:${edges.length}`,
    `indeg:${inEdges.length}`,
    `rels:${relationProfile}`,
  ].join('::');

  const idSignal = projectionWeight(seed, dim, totalDims);
  const labelSignal = projectionWeight(`label:${label}`, dim, totalDims);
  const degreeSignal = projectionWeight(`degree:${edges.length}:${inEdges.length}`, dim, totalDims);
  return (idSignal * 0.58) + (labelSignal * 0.27) + (degreeSignal * 0.15);
}

/** Counts co-occurrence of node ids within a sliding window across walks. */
function buildCooccurrence(walks, windowSize) {
  const cooc = new Map();
  for (const walk of walks) {
    for (let i = 0; i < walk.length; i++) {
      const center = walk[i];
      if (!cooc.has(center)) cooc.set(center, new Map());
      const ctx = cooc.get(center);
      const start = Math.max(0, i - windowSize);
      const end = Math.min(walk.length - 1, i + windowSize);
      for (let j = start; j <= end; j++) {
        if (i === j) continue;
        ctx.set(walk[j], (ctx.get(walk[j]) || 0) + 1);
      }
    }
  }
  return cooc;
}

/**
 * node2vec biased random walk over bare node ids in one workspace.
 *
 * `getEdges(id, workspaceId)` is the graph read surface; `start` is a bare node
 * id, not a storage key (#1189).
 */
function biasedWalk(graph, start, length, p, q, random, workspaceId = 'default') {
  const path = [start];
  const visited = new Set([start]); // döngü önleme için Set kullan
  let prev = null;
  let current = start;

  for (let i = 0; i < length; i++) {
    const edges = graph.getEdges(current, workspaceId);
    // Ziyaret edilmemiş komşuları filtrele
    const candidates = edges.filter(e => !visited.has(e.to));
    if (candidates.length === 0) break;

    // node2vec bias ağırlıkları
    const weights = candidates.map(e => {
      if (prev === null) return e.weight;
      if (e.to === prev) return e.weight / p;                    // geri dön
      const prevEdges = graph.getEdges(prev, workspaceId);
      const connected = prevEdges.some(pe => pe.to === e.to);
      return e.weight / (connected ? 1.0 : q);                   // BFS vs DFS
    });

    const total = weights.reduce((s, w) => s + w, 0);
    if (total === 0) break;

    let r = random() * total;
    let pick = candidates[candidates.length - 1]; // fallback
    for (let j = 0; j < candidates.length; j++) {
      r -= weights[j];
      if (r <= 0) { pick = candidates[j]; break; }
    }

    path.push(pick.to);
    visited.add(pick.to);
    prev = current;
    current = pick.to;
  }

  return path;
}

/**
 * Runs the embedding pass over one workspace.
 *
 * `ctx` is a plain-function context supplied by the caller, so this module
 * never touches another object's private members:
 *   - emit(event, data)
 *   - seededRandom(seed)
 *   - biasedWalk(start, length, p, q, random, workspaceId)
 *   - projectionWeight(str, dim, totalDims)
 *   - nodeSignatureWeight(node, dim, totalDims, workspaceId)
 *   - nodesInWorkspace(workspaceId) -> [{ id, storageKey, node }]
 *   - assignEmbedding(storageKey, vector)
 */
function runEmbedding(ctx, opts = {}) {
  ctx.emit('beforeEmbedding', opts);
  const dims = opts.dimensions || 64;
  const walksPerNode = opts.walksPerNode || 10;
  const walkLength = opts.walkLength || 20;
  const windowSize = opts.windowSize || 5;
  const p = opts.p || 1.0;
  const q = opts.q || 1.0;
  // #1189 put every graph read on `dream()` inside one workspace. The embedding
  // path was left global, and it reads `_nodes` directly, whose keys are storage
  // keys (`nodeStorageKey`), not the bare ids the graph read methods take.
  // Outside `default` the two never meet: every walk started on a key getEdges()
  // does not know, so every walk was length 1, every vector was the node's own
  // signature, and every cosine similarity came back 0 -- an embedding that
  // carries no graph information at all.
  const workspaceId = normalizeWorkspaceId(
    opts && typeof opts === 'object' && !Array.isArray(opts) ? opts.workspaceId : opts,
  );
  // Embeddings must be reproducible by default; callers can inject a random
  // source for experiments without making the normal path flaky.
  const random = typeof opts.random === 'function'
    ? opts.random
    : ctx.seededRandom(opts.seed ?? 'huqan-dream-embedding');

  // Node ids are the bare ids the read methods accept; the storage key is only
  // how the node is addressed for the write at the end of this pass.
  const nodes = ctx.nodesInWorkspace(workspaceId);
  if (nodes.length < 2) return null;

  const walks = [];
  for (const { id } of nodes) {
    for (let w = 0; w < walksPerNode; w++) {
      walks.push(ctx.biasedWalk(id, walkLength, p, q, random, workspaceId));
    }
  }

  const cooc = buildCooccurrence(walks, windowSize);

  // Vektör üret — geliştirilmiş random projection (sadece +1/-1 yerine sürekli değer)
  for (const { id, storageKey, node } of nodes) {
    const ctxMap = cooc.get(id) || new Map();
    const vec = new Float64Array(dims);
    for (let d = 0; d < dims; d++) {
      let sum = 0;
      for (const [contextId, count] of ctxMap) {
        sum += count * ctx.projectionWeight(contextId, d, dims);
      }
      const signature = ctx.nodeSignatureWeight(node, d, dims, workspaceId);
      vec[d] = sum + signature * 0.18;
    }
    // L2 normalize
    let mag = 0;
    for (let d = 0; d < dims; d++) mag += vec[d] * vec[d];
    mag = Math.sqrt(mag);
    if (mag > 0) for (let d = 0; d < dims; d++) vec[d] /= mag;
    ctx.assignEmbedding(storageKey, vec);
  }

  const result = { dimensions: dims, nodes: nodes.length };
  ctx.emit('afterEmbedding', { ...result, workspaceId });
  return result;
}

module.exports = {
  projectionWeight,
  nodeSignatureWeight,
  biasedWalk,
  buildCooccurrence,
  runEmbedding,
};
