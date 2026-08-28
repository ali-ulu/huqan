const { normalizeWorkspaceId } = require('./lib/graph-record-utils');
const { isSymmetricRelation, nodesAreDisjoint, isEligibleHypothesisNode } = require('./lib/dream-hypothesis-semantics');

const MAX_DREAM_COMPARISONS = 10_000;
const MAX_DREAM_WORK = 50_000;
const MIN_DREAM_NODE_QUALITY = 0.3;

function measureDreamNodeQuality(value) {
  if (typeof value !== 'string') return 0;
  const text = value.normalize('NFKC').trim();
  if (!text || !/\p{L}/u.test(text)) return 0;

  // Markdown table fragments and rendered list/quote markers are document
  // structure, not concepts. A pipe anywhere in a node is especially strong
  // evidence that a table row was ingested as prose (#1643).
  if (text.includes('|') || /^(?:#{1,6}|[-*+]|>)\s+/u.test(text)) return 0;

  // Volatile CI execution identifiers create pairs that differ only by an
  // opaque number (for example "npm test job 93172327986 success"). They are
  // useful provenance, but not stable graph concepts from which to dream.
  if (/\b(?:job|run|build|workflow|check)[\s_:#-]+\d{5,}\b/iu.test(text)) return 0;

  const alphanumeric = Array.from(text).filter(char => /[\p{L}\p{N}]/u.test(char));
  const digitCount = alphanumeric.filter(char => /\p{N}/u.test(char)).length;
  const digitRatio = digitCount / Math.max(1, alphanumeric.length);
  const wordCount = text.split(/\s+/u).filter(Boolean).length;

  let quality = text.length === 1 ? 0.35 : 0.6;
  if (text.length >= 4) quality += 0.15;
  if (wordCount >= 2 && wordCount <= 8) quality += 0.1;
  if (text.length > 160) quality -= 0.2;
  if (digitRatio > 0.35) quality -= 0.25;
  return Math.max(0, Math.min(1, quality));
}

function hypothesisNodeQuality(hypothesis) {
  const values = [
    hypothesis.from,
    hypothesis.to,
    hypothesis.node,
    hypothesis.via,
    ...(Array.isArray(hypothesis.targets) ? hypothesis.targets : []),
  ].filter(value => value !== undefined && value !== null);
  if (values.length === 0) return 0;
  return Math.min(...values.map(measureDreamNodeQuality));
}

class Dream {
  constructor(kernel) {
    this.kernel = kernel;
    this.graph = kernel.graph;
  }

  _emit(event, data) {
    if (this.kernel && this.kernel.plugins && typeof this.kernel.plugins.emit === 'function') {
      this.kernel.plugins.emit(event, data);
    }
    return data;
  }

  // ─── Embedding ────────────────────────────────────────────────────────────

  embedding(opts = {}) {
    this._emit('beforeEmbedding', opts);
    const dims        = opts.dimensions   || 64;
    const walksPerNode = opts.walksPerNode || 10;
    const walkLength  = opts.walkLength   || 20;
    const windowSize  = opts.windowSize   || 5;
    const p           = opts.p            || 1.0;
    const q           = opts.q            || 1.0;
    // Embeddings must be reproducible by default; callers can inject a random
    // source for experiments without making the normal path flaky.
    const random = typeof opts.random === 'function'
      ? opts.random
      : this._seededRandom(opts.seed ?? 'huqan-dream-embedding');

    const nodes = Object.keys(this.graph._nodes);
    if (nodes.length < 2) return null;

    // Random walk'lar
    const walks = [];
    for (const id of nodes) {
      for (let w = 0; w < walksPerNode; w++) {
        walks.push(this._biasedWalk(id, walkLength, p, q, random));
      }
    }

    // Co-occurrence matrisi
    const cooc = new Map();
    for (const walk of walks) {
      for (let i = 0; i < walk.length; i++) {
        const center = walk[i];
        if (!cooc.has(center)) cooc.set(center, new Map());
        const ctx = cooc.get(center);
        const start = Math.max(0, i - windowSize);
        const end   = Math.min(walk.length - 1, i + windowSize);
        for (let j = start; j <= end; j++) {
          if (i === j) continue;
          ctx.set(walk[j], (ctx.get(walk[j]) || 0) + 1);
        }
      }
    }

    // Vektör üret — geliştirilmiş random projection (sadece +1/-1 yerine sürekli değer)
    for (const id of nodes) {
      const ctx = cooc.get(id) || new Map();
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
      // L2 normalize
      let mag = 0;
      for (let d = 0; d < dims; d++) mag += vec[d] * vec[d];
      mag = Math.sqrt(mag);
      if (mag > 0) for (let d = 0; d < dims; d++) vec[d] /= mag;
      this.graph._assignEmbedding(id, vec);
    }

    const result = { dimensions: dims, nodes: nodes.length };
    this._emit('afterEmbedding', result);
    return result;
  }

  /**
   * Geliştirilmiş projeksiyon ağırlığı.
   * Eski _hash sadece +1/-1 döndürüyordu — bu çok kaba.
   * Şimdi Gaussian benzeri sürekli değer üretiyoruz (FNV-1a tabanlı).
   */
  _projectionWeight(str, dim, totalDims) {
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

  _nodeSignatureWeight(node, dim, totalDims) {
    const edges = this.graph.getEdges(node.id);
    const inEdges = this.graph.getInEdges(node.id);
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

    const idSignal = this._projectionWeight(seed, dim, totalDims);
    const labelSignal = this._projectionWeight(`label:${label}`, dim, totalDims);
    const degreeSignal = this._projectionWeight(`degree:${edges.length}:${inEdges.length}`, dim, totalDims);
    return (idSignal * 0.58) + (labelSignal * 0.27) + (degreeSignal * 0.15);
  }

  nodeSimilarity(a, b) {
    const va = this.graph._nodes[a]?.embedding;
    const vb = this.graph._nodes[b]?.embedding;
    if (!va || !vb) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < va.length; i++) {
      dot  += va[i] * vb[i];
      magA += va[i] * va[i];
      magB += vb[i] * vb[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
  }

  findSimilar(nodeId, n = 5) {
    const ids = Object.keys(this.graph._nodes);
    const scored = ids
      .filter(id => id !== nodeId)
      .map(id => ({ id, score: this.nodeSimilarity(nodeId, id) }))
      .filter(s => s.score > 0);
    return scored.sort((a, b) => b.score - a.score).slice(0, n);
  }

  // ─── Random Walk ──────────────────────────────────────────────────────────

  _seededRandom(seed) {
    let state = 2166136261;
    for (const char of String(seed)) {
      state ^= char.charCodeAt(0);
      state = Math.imul(state, 16777619);
    }
    return () => {
      state ^= state >>> 13;
      state = Math.imul(state, 16777619);
      state ^= state >>> 16;
      return (state >>> 0) / 4294967296;
    };
  }

  _biasedWalk(start, length, p, q, random = Math.random) {
    const path    = [start];
    const visited = new Set([start]); // döngü önleme için Set kullan
    let prev      = null;
    let current   = start;

    for (let i = 0; i < length; i++) {
      const edges = this.graph.getEdges(current);
      // Ziyaret edilmemiş komşuları filtrele
      const candidates = edges.filter(e => !visited.has(e.to));
      if (candidates.length === 0) break;

      // node2vec bias ağırlıkları
      const weights = candidates.map(e => {
        if (prev === null) return e.weight;
        if (e.to === prev) return e.weight / p;                    // geri dön
        const prevEdges = this.graph.getEdges(prev);
        const connected = prevEdges.some(pe => pe.to === e.to);
        return e.weight / (connected ? 1.0 : q);                   // BFS vs DFS
      });

      const total = weights.reduce((s, w) => s + w, 0);
      if (total === 0) break;

      let r    = random() * total;
      let pick = candidates[candidates.length - 1]; // fallback
      for (let j = 0; j < candidates.length; j++) {
        r -= weights[j];
        if (r <= 0) { pick = candidates[j]; break; }
      }

      path.push(pick.to);
      visited.add(pick.to);
      prev    = current;
      current = pick.to;
    }

    return path;
  }

  // ─── Composite Skorlama ──────────────────────────────────────────────────

  _calculateCompositeScore(hyp, context = null) {
    const confidence = hyp.confidence || 0.3;
    const scope = normalizeWorkspaceId(context ? context.workspaceId : undefined);
    const quality = hypothesisNodeQuality(hyp);

    let novelty = 0;
    if (hyp.type === 'çelişki') {
      novelty = 1.0;
    } else if (hyp.from && hyp.to) {
      const exists = context
        ? context.outTargets.get(hyp.from)?.has(hyp.to)
          || context.outTargets.get(hyp.to)?.has(hyp.from)
        : this.graph.getEdges(hyp.from, scope).some(e => e.to === hyp.to)
          || this.graph.getEdges(hyp.to, scope).some(e => e.to === hyp.from);
      novelty = exists ? 0 : 1;
    }

    let usefulness = 0;
    const nodeId = hyp.from || hyp.node;
    if (nodeId) {
      const outDeg = context ? (context.outEdges.get(nodeId)?.length || 0) : this.graph.getEdges(nodeId, scope).length;
      const inDeg = context ? (context.inEdges.get(nodeId)?.length || 0) : this.graph.getInEdges(nodeId, scope).length;
      const deg = outDeg + inDeg;
      const nodes = context ? context.nodes : Object.values(this.graph._nodes);
      const avgDeg = context ? context.avgDeg : nodes.reduce((s, n) => {
        return s + this.graph.getEdges(n.id, scope).length + this.graph.getInEdges(n.id, scope).length;
      }, 0) / Math.max(1, nodes.length);
      usefulness = avgDeg > 0 ? Math.min(1, deg / avgDeg) : 0;
    }

    return {
      score: confidence * 0.45 + novelty * 0.25 + usefulness * 0.2 + quality * 0.1,
      confidence,
      novelty,
      usefulness,
      quality,
    };
  }

  // ─── Dream (Hipotez Üretimi) ──────────────────────────────────────────────

  /**
   * #1189: every graph read on this path is workspace-scoped, and the node set
   * is the workspace's own. Reading `_nodes` whole while calling getEdges()
   * without a scope meant a non-default workspace saw its nodes but the default
   * workspace's edges -- no edges, so no hypotheses, so a silent empty dream.
   * The scope rides on the context so the finders cannot forget it.
   */
  dream(opts = {}) {
    const workspaceId = normalizeWorkspaceId(
      opts && typeof opts === 'object' && !Array.isArray(opts) ? opts.workspaceId : opts,
    );
    this._emit('beforeDream', { workspaceId });
    const nodes = Object.values(this.graph._nodes)
      .filter(node => normalizeWorkspaceId(node.workspaceId) === workspaceId)
      .filter(node => measureDreamNodeQuality(node.id) >= MIN_DREAM_NODE_QUALITY);
    if (nodes.length < 2) {
      this._emit('afterDream', { hypotheses: [], workspaceId });
      return [];
    }

    const context = this._createDreamContext(nodes, workspaceId);
    // #1643: punctuation debris and id-like labels ("|", "93172327986") are
    // excluded as hypothesis *sources*. They still exist in the graph as edge
    // targets; a proposal anchored on an eligible node may still reference
    // them via `via`, but no hypothesis is born from noise.
    const eligibleNodes = nodes.filter(node => isEligibleHypothesisNode(node.id));
    const hypotheses = [];
    this._findSimilarityHypotheses(eligibleNodes, hypotheses, context);
    this._findTransitiveHypotheses(eligibleNodes, hypotheses, context);
    this._findGapHypotheses(eligibleNodes, hypotheses, context);
    this._findSymmetryHypotheses(eligibleNodes, hypotheses, context);
    this._findContradictionHypotheses(eligibleNodes, hypotheses, context);

    const scored = hypotheses
      .map(h => ({
        ...h,
        ...this._calculateCompositeScore(h, context),
      }))
      .filter(h => h.quality >= MIN_DREAM_NODE_QUALITY);

    const contradictions = scored.filter(h => h.type === 'çelişki');
    const others = scored.filter(h => h.type !== 'çelişki');

    contradictions.sort((a, b) => b.confidence - a.confidence);
    others.sort((a, b) => b.score - a.score);

    const result = [...contradictions, ...others].slice(0, 10);

    this._emit('afterDream', { hypotheses: result, workspaceId });
    return result;
  }

  _createDreamContext(nodes, workspaceId = 'default') {
    const outEdges = new Map();
    const inEdges = new Map();
    const outTargets = new Map();
    const edgesByTarget = new Map();
    const relationTargets = new Map();
    const allowedNodeIds = new Set(nodes.map(node => node.id));
    let degreeTotal = 0;

    for (const node of nodes) {
      const outgoing = this.graph.getEdges(node.id, workspaceId)
        .filter(edge => allowedNodeIds.has(edge.to));
      const incoming = this.graph.getInEdges(node.id, workspaceId)
        .filter(edge => allowedNodeIds.has(edge.from));
      outEdges.set(node.id, outgoing);
      inEdges.set(node.id, incoming);
      outTargets.set(node.id, new Set(outgoing.map(edge => edge.to)));

      const byTarget = new Map();
      const byRelation = new Map();
      for (const edge of outgoing) {
        if (!byTarget.has(edge.to)) byTarget.set(edge.to, edge);
        if (!byRelation.has(edge.relation)) byRelation.set(edge.relation, new Set());
        byRelation.get(edge.relation).add(edge.to);
      }
      edgesByTarget.set(node.id, byTarget);
      relationTargets.set(node.id, byRelation);
      degreeTotal += outgoing.length + incoming.length;
    }

    return {
      nodes,
      workspaceId,
      // #1213: memoised type ancestors, so the disjointness guard on the
      // O(n²) similarity pass does not re-walk the lattice per pair.
      typeAncestors: new Map(),
      outEdges,
      inEdges,
      outTargets,
      edgesByTarget,
      relationTargets,
      avgDeg: degreeTotal / Math.max(1, nodes.length),
      comparisonsRemaining: MAX_DREAM_COMPARISONS,
      workRemaining: MAX_DREAM_WORK,
    };
  }

  _consumeDreamWork(context, kind = 'work') {
    if (context.workRemaining <= 0) return false;
    if (kind === 'comparison') {
      if (context.comparisonsRemaining <= 0) return false;
      context.comparisonsRemaining--;
    }
    context.workRemaining--;
    return true;
  }

  _findSimilarityHypotheses(nodes, hypotheses, context) {
    const checked = new Set();
    let added = 0;
    for (let i = 0; i < nodes.length && added < 50; i++) {
      for (let j = i + 1; j < nodes.length && added < 50; j++) {
        if (!this._consumeDreamWork(context, 'comparison')) return;
        const a = nodes[i], b = nodes[j];
        const key = `${a.id}|${b.id}`;
        if (checked.has(key)) continue;
        checked.add(key);

        const aEdges   = context.outEdges.get(a.id);
        const bEdges   = context.outEdges.get(b.id);
        const aTargets = context.outTargets.get(a.id);
        const bTargets = context.outTargets.get(b.id);
        const common   = [...aTargets].filter(t => bTargets.has(t));

        // #1213: the lattice already says these two cannot both apply, so a
        // similarity edge between them can only ever be rejected -- after
        // costing a reviewer's attention in the approval queue.
        const disjoint = nodesAreDisjoint(
          nodeId => context.outEdges.get(nodeId), a.id, b.id, context.workspaceId, context.typeAncestors);

        if (common.length > 0 && !disjoint) {
          const existing = context.relationTargets.get(a.id)?.get('benzer')?.has(b.id)
                        || context.relationTargets.get(b.id)?.get('benzer')?.has(a.id);
          if (!existing) {
            const avgWeight = common.reduce((s, t) => {
              const ae = context.edgesByTarget.get(a.id).get(t);
              const be = context.edgesByTarget.get(b.id).get(t);
              return s + (ae ? ae.weight : 0) + (be ? be.weight : 0);
            }, 0) / (common.length * 2);
            hypotheses.push({
              type: 'benzerlik',
              from: a.id,
              to: b.id,
              via: common[0],
              confidence: Math.min(0.7, 0.2 + avgWeight * 0.4 * common.length),
              ortak_sayısı: common.length,
            });
            added++;
          }
        }

        const sim = disjoint ? 0 : this.graph.cosineSimilarity(a.id, b.id, context.workspaceId);
        if (sim > 0.5) {
          const hasEdge = context.outTargets.get(a.id).has(b.id)
                       || context.outTargets.get(b.id).has(a.id);
          if (!hasEdge) {
            hypotheses.push({
              type: 'vektör-benzerlik',
              from: a.id,
              to: b.id,
              confidence: Math.min(0.5, sim * 0.6),
              benzerlik: sim,
            });
            added++;
          }
        }
      }
    }
  }

  _findTransitiveHypotheses(nodes, hypotheses, context) {
    let added = 0;
    for (const node of nodes) {
      if (added >= 50) break;
      const edges = context.outEdges.get(node.id);
      for (const edge of edges) {
        if (added >= 50) break;
        const transEdges = context.outEdges.get(edge.to) || [];
        for (const te of transEdges) {
          if (added >= 50) break;
          if (!this._consumeDreamWork(context)) return;
          if (te.to === node.id) continue;
          const existing = context.relationTargets.get(node.id)?.get(edge.relation)?.has(te.to);
          if (!existing) {
            hypotheses.push({
              type: 'zincir',
              from: node.id,
              to: te.to,
              via: edge.to,
              confidence: Math.min(0.6, edge.weight * te.weight * 3.0),
              relation: edge.relation,
            });
            added++;
          }
        }
      }
    }
  }

  _findGapHypotheses(nodes, hypotheses, context) {
    const gaps = this.kernel.detectGaps(context.workspaceId);
    if (gaps.length === 0 || nodes.length < 2) return;

    let added = 0;
    for (const gapId of gaps) {
      if (added >= 50) break;
      const gapNode = this.graph.getNode(gapId, context.workspaceId);
      if (!gapNode) continue;

      let best = null, bestSim = 0;
      for (const n of nodes) {
        if (n.id === gapId) continue;
        if (!this._consumeDreamWork(context, 'comparison')) return;
        const sim = this.graph.cosineSimilarity(gapId, n.id, context.workspaceId);
        if (sim > bestSim) { bestSim = sim; best = n.id; }
      }

      if (best && bestSim > 0.1) {
        hypotheses.push({
          type: 'bağlantı-önerisi',
          from: gapId,
          to: best,
          confidence: Math.min(0.4, bestSim * 0.5),
          benzerlik: bestSim,
        });
        added++;
      }
    }
  }

  _findSymmetryHypotheses(nodes, hypotheses, context) {
    let added = 0;
    for (const node of nodes) {
      if (added >= 50) break;
      const edges = context.outEdges.get(node.id);
      for (const edge of edges) {
        if (added >= 50) break;
        if (!this._consumeDreamWork(context)) return;
        // #1213: `tür` is not symmetric -- a cat is an animal, an animal is not
        // a cat -- and proposing its reverse builds the two-node cycle verify's
        // `döngü` rule reports as a contradiction. Unlisted relations count as
        // asymmetric: this generator's output is a write proposal.
        if (!isSymmetricRelation(edge.relation)) continue;
        const reverse    = context.relationTargets.get(edge.to)?.get(edge.relation)?.has(node.id);
        const reverseAny = context.outTargets.get(edge.to)?.has(node.id);
        if (!reverse && !reverseAny) {
          hypotheses.push({
            type: 'simetri',
            from: edge.to,
            to: node.id,
            via: edge.relation,
            confidence: edge.weight * 0.3,
            relation: edge.relation,
          });
          added++;
        }
      }
    }
  }

  _findContradictionHypotheses(nodes, hypotheses, context = null) {
    if (typeof this.kernel.detectContradictions !== 'function') return;
    try {
      const contradictions = this.kernel.detectContradictions('', normalizeWorkspaceId(context ? context.workspaceId : undefined));
      let added = 0;
      for (const c of contradictions) {
        if (added >= 50) break;
        // #1643: a contradiction anchored on punctuation debris or between
        // id-like labels is noise, not insight -- the detector fires on graph
        // shape and cannot tell "pr | #2" from "köpek".
        if (!isEligibleHypothesisNode(c.node)) continue;
        let targets = (c.targets || []).filter(t => isEligibleHypothesisNode(t));
        // #1643: targets that differ only in their digits are the same line
        // observed twice (CI job IDs, PR numbers) -- the detector cannot know
        // that, but a hypothesis claiming they contradict each other carries
        // no information. Collapse digit runs before judging novelty.
        const idVariants = new Set(targets.map(t => String(t).replace(/\d+/g, '#').trim()));
        if (idVariants.size < Math.min(2, targets.length)) continue;
        if (targets.length === 0) continue;
        hypotheses.push({
          type: 'çelişki',
          node: c.node,
          targets,
          confidence: c.confidence || 0.4,
        });
        added++;
      }
    } catch (_) {}
  }

  // ─── Amplify / Simulate / Verify ─────────────────────────────────────────

  amplify(subject, candidates, relation) {
    const scored = candidates.map(c => {
      const edge     = this.graph.getEdge(subject, c, relation);
      const verified = this.verify(subject, c);
      return {
        answer: c,
        score: edge
          ? edge.weight * (verified.valid ? 1 : 0.5)
          : (verified.valid ? 0.3 : 0),
        verified: verified.valid,
      };
    });

    for (let iter = 0; iter < 5; iter++) {
      const totalScore = scored.reduce((sum, s) => sum + s.score, 0);
      if (totalScore === 0) break;
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

    return scored.sort((a, b) => b.score - a.score).map(s => s.answer);
  }

  simulate(subject) {
    const node = this.graph.getNode(subject);
    if (!node) return [];

    const edges = this.graph.getEdges(subject);
    const scored = edges.map(e => ({
      answer: e.to,
      score: e.weight * (e.relation === 'tür' ? 1.2 : 1.0),
    }));

    // Vektör benzerliği ile ek adaylar
    const allNodes = Object.values(this.graph._nodes);
    for (const n of allNodes) {
      if (n.id !== subject && !scored.some(s => s.answer === n.id)) {
        const sim = this.graph.cosineSimilarity(subject, n.id);
        if (sim > 0.3) scored.push({ answer: n.id, score: sim * 0.5 });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  verify(subject, object) {
    const visited = new Set();
    const path    = [];
    const found   = this._dfs(subject, object, visited, path, 5);
    if (found) {
      return { valid: true, confidence: this._pathConfidence(path), path };
    }
    return { valid: false, confidence: 0, path: [] };
  }

  _dfs(current, target, visited, path, depth) {
    if (depth <= 0 || visited.has(current)) return false;
    visited.add(current);
    path.push(current);
    if (current === target) return true;

    for (const e of this.graph.getEdges(current)) {
      if (!visited.has(e.to) && this._dfs(e.to, target, visited, path, depth - 1)) return true;
    }
    for (const ie of this.graph.getInEdges(current)) {
      if (!visited.has(ie.from) && this._dfs(ie.from, target, visited, path, depth - 1)) return true;
    }

    path.pop();
    visited.delete(current);
    return false;
  }

  _pathConfidence(path) {
    let conf = 1;
    for (let i = 0; i < path.length - 1; i++) {
      const edge = this.graph.getEdges(path[i]).find(e => e.to === path[i + 1])
                || this.graph.getInEdges(path[i]).find(e => e.from === path[i + 1]);
      if (edge) conf *= edge.weight;
    }
    return conf;
  }

  walk(start, maxDepth) {
    const path    = [start];
    const visited = new Set([start]);
    let current   = start;

    for (let i = 0; i < maxDepth; i++) {
      const edges = this.graph.getEdges(current).filter(e => !visited.has(e.to));
      if (edges.length === 0) break;
      const pick = edges.sort((a, b) => b.weight - a.weight)[0];
      path.push(pick.to);
      visited.add(pick.to);
      current = pick.to;
    }

    return path;
  }
}

module.exports = Dream;
