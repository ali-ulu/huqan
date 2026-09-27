'use strict';

/**
 * The Node2Vec embedding pass, extracted from `dream.js` so the file-size
 * ratchet (#328) does not have to choose between a fix and a budget.
 *
 * The `dream` argument is the Dream instance: the pass deliberately reaches
 * back through it (`dream._biasedWalk`, `dream._nodeSignatureWeight`,
 * `dream._emit`) so that callers and tests that override those methods keep
 * working exactly as before.
 */

const { normalizeWorkspaceId, nodeStorageKey } = require('./graph-record-utils');

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

function runEmbedding(dream, opts = {}) {
  dream._emit('beforeEmbedding', opts);
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
    : dream._seededRandom(opts.seed ?? 'huqan-dream-embedding');

  // Node ids are the bare ids the read methods accept; the storage key is only
  // how the node is addressed for the write at the end of this pass.
  const nodes = Object.values(dream.graph._nodes)
    .filter(node => normalizeWorkspaceId(node.workspaceId) === workspaceId)
    .map(node => ({ id: node.id, storageKey: nodeStorageKey(node.id, workspaceId), node }));
  if (nodes.length < 2) return null;

  const walks = [];
  for (const { id } of nodes) {
    for (let w = 0; w < walksPerNode; w++) {
      walks.push(dream._biasedWalk(id, walkLength, p, q, random, workspaceId));
    }
  }

  const cooc = buildCooccurrence(walks, windowSize);

  // Vektör üret — geliştirilmiş random projection (sadece +1/-1 yerine sürekli değer)
  for (const { id, storageKey, node } of nodes) {
    const ctx = cooc.get(id) || new Map();
    const vec = new Float64Array(dims);
    for (let d = 0; d < dims; d++) {
      let sum = 0;
      for (const [contextId, count] of ctx) {
        sum += count * dream._projectionWeight(contextId, d, dims);
      }
      const signature = dream._nodeSignatureWeight(node, d, dims, workspaceId);
      vec[d] = sum + signature * 0.18;
    }
    // L2 normalize
    let mag = 0;
    for (let d = 0; d < dims; d++) mag += vec[d] * vec[d];
    mag = Math.sqrt(mag);
    if (mag > 0) for (let d = 0; d < dims; d++) vec[d] /= mag;
    dream.graph.assignEmbedding(storageKey, vec);
  }

  const result = { dimensions: dims, nodes: nodes.length };
  dream._emit('afterEmbedding', { ...result, workspaceId });
  return result;
}

module.exports = { projectionWeight, nodeSignatureWeight, buildCooccurrence, runEmbedding };
