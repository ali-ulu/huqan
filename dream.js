const { normalizeWorkspaceId, nodeStorageKey } = require('./lib/graph-record-utils');
const { isEligibleHypothesisNode } = require('./lib/dream-hypothesis-semantics');
const {
  projectionWeight,
  nodeSignatureWeight,
  biasedWalk,
  runEmbedding,
} = require('./lib/dream-embedding');
const {
  MIN_DREAM_NODE_QUALITY,
  measureDreamNodeQuality,
  calculateCompositeScore,
} = require('./lib/dream-hypothesis-scoring');
const {
  createDreamContext,
  findSimilarityHypotheses,
  findTransitiveHypotheses,
  findGapHypotheses,
  findSymmetryHypotheses,
  appendContradictionHypotheses,
} = require('./lib/dream-hypothesis-finders');
const { verifyPath, greedyWalk } = require('./lib/dream-graph-paths');

class Dream {
  constructor(kernel) {
    this.kernel = kernel;
    this.graph = kernel.graph;
    this._contradictionSkipped = 0;
    this._contradictionLastError = null;
  }

  _emit(event, data) {
    if (this.kernel && this.kernel.plugins && typeof this.kernel.plugins.emit === 'function') {
      this.kernel.plugins.emit(event, data);
    }
    return data;
  }

  // ─── Embedding ────────────────────────────────────────────────────────────

  embedding(opts = {}) {
    return runEmbedding(this._embeddingContext(), opts);
  }

  /**
   * The embedding pass lives in `lib/dream-embedding.js`; it takes this
   * context instead of the Dream instance so the extracted module never reaches
   * into `this._*` from outside (docs/architecture-policy.md §4). Every member
   * is read off `this` at call time, so a caller that overrides
   * `_biasedWalk`/`_nodeSignatureWeight`/`_projectionWeight` is still honoured.
   */
  _embeddingContext() {
    return {
      emit: (event, data) => this._emit(event, data),
      seededRandom: seed => this._seededRandom(seed),
      biasedWalk: (start, length, p, q, random, workspaceId) =>
        this._biasedWalk(start, length, p, q, random, workspaceId),
      projectionWeight: (str, dim, totalDims) => this._projectionWeight(str, dim, totalDims),
      nodeSignatureWeight: (node, dim, totalDims, workspaceId) =>
        this._nodeSignatureWeight(node, dim, totalDims, workspaceId),
      nodesInWorkspace: workspaceId => Object.values(this.graph._nodes)
        .filter(node => normalizeWorkspaceId(node.workspaceId) === workspaceId)
        .map(node => ({ id: node.id, storageKey: nodeStorageKey(node.id, workspaceId), node })),
      assignEmbedding: (storageKey, vector) => this.graph.assignEmbedding(storageKey, vector),
    };
  }

  _projectionWeight(str, dim, totalDims) {
    return projectionWeight(str, dim, totalDims);
  }

  _nodeSignatureWeight(node, dim, totalDims, workspaceId = 'default') {
    return nodeSignatureWeight(this.graph, node, dim, totalDims, workspaceId);
  }

  nodeSimilarity(a, b, workspaceId = 'default') {
    const va = this.graph.getNode(a, workspaceId)?.embedding;
    const vb = this.graph.getNode(b, workspaceId)?.embedding;
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

  findSimilar(nodeId, n = 5, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts && typeof opts === 'object' ? opts.workspaceId : opts);
    const ids = Object.values(this.graph._nodes)
      .filter(node => normalizeWorkspaceId(node.workspaceId) === workspaceId)
      .map(node => node.id);
    const scored = ids
      .filter(id => id !== nodeId)
      .map(id => ({ id, score: this.nodeSimilarity(nodeId, id, workspaceId) }))
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

  _biasedWalk(start, length, p, q, random = Math.random, workspaceId = 'default') {
    return biasedWalk(this.graph, start, length, p, q, random, workspaceId);
  }

  // ─── Composite Skorlama ──────────────────────────────────────────────────

  _calculateCompositeScore(hyp, context = null) {
    return calculateCompositeScore(this.graph, hyp, context);
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

    const context = createDreamContext(this.graph, nodes, workspaceId);
    // #1643: punctuation debris and id-like labels ("|", "93172327986") are
    // excluded as hypothesis *sources*. They still exist in the graph as edge
    // targets; a proposal anchored on an eligible node may still reference
    // them via `via`, but no hypothesis is born from noise.
    const eligibleNodes = nodes.filter(node => isEligibleHypothesisNode(node.id));
    const hypotheses = [];
    findSimilarityHypotheses(this.graph, eligibleNodes, hypotheses, context);
    findTransitiveHypotheses(eligibleNodes, hypotheses, context);
    findGapHypotheses(this.kernel, this.graph, eligibleNodes, hypotheses, context);
    findSymmetryHypotheses(eligibleNodes, hypotheses, context);
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

  _findContradictionHypotheses(nodes, hypotheses, context = null) {
    if (typeof this.kernel.detectContradictions !== 'function') return;
    try {
      const contradictions = this.kernel.detectContradictions('', normalizeWorkspaceId(context ? context.workspaceId : undefined));
      appendContradictionHypotheses(contradictions, hypotheses);
    } catch (error) {
      // #1986: a detector throw used to be indistinguishable from a genuine
      // empty result (both yield hypotheses=0 with no signal). Count it and
      // leave telemetry so callers can tell "detector failed" apart from
      // "no contradictions found".
      this._contradictionSkipped += 1;
      this._contradictionLastError = (error && error.message) || String(error);
      this._emit('dreamContradictionSkipped', {
        workspaceId: normalizeWorkspaceId(context ? context.workspaceId : undefined),
        error: this._contradictionLastError,
        skippedTotal: this._contradictionSkipped,
      });
    }
  }

  // ─── Amplify / Simulate / Verify ─────────────────────────────────────────

  /**
   * Rank candidates for an amplified subject, highest score first.
   *
   * `graph.getEdge()` returns a clone, so the previous five-iteration loop
   * wrote `edge.weight` onto a throwaway object: it changed nothing, in the
   * graph or anywhere else, while the method's shape implied the answer had
   * been reinforced. There is no receipted edge-weight write port on the graph
   * -- `addEdge` is the only mutation, and re-adding would replace the record --
   * so the honest state is to expose the intended delta alongside the ranking
   * and let a caller with a mutation path apply it.
   */
  amplify(subject, candidates, relation, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts && typeof opts === 'object' ? opts.workspaceId : opts);
    const scored = candidates.map(c => {
      const edge     = this.graph.getEdge(subject, c, relation, workspaceId);
      const verified = this._verify(subject, c, workspaceId);
      return {
        answer: c,
        score: edge
          ? edge.weight * (verified.valid ? 1 : 0.5)
          : (verified.valid ? 0.3 : 0),
        verified: verified.valid,
      };
    });

    const totalScore = scored.reduce((sum, s) => sum + s.score, 0);
    for (const s of scored) {
      s.weightDelta = s.score > 0 && totalScore > 0 ? Math.min(0.1, (s.score / totalScore) * 0.1) : 0;
    }

    return scored.sort((a, b) => b.score - a.score).map(s => s.answer);
  }

  simulate(subject, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts && typeof opts === 'object' ? opts.workspaceId : opts);
    const node = this.graph.getNode(subject, workspaceId);
    if (!node) return [];

    const edges = this.graph.getEdges(subject, workspaceId);
    const scored = edges.map(e => ({
      answer: e.to,
      score: e.weight * (e.relation === 'tür' ? 1.2 : 1.0),
    }));

    // Vektör benzerliği ile ek adaylar
    const allNodes = Object.values(this.graph._nodes)
      .filter(candidate => normalizeWorkspaceId(candidate.workspaceId) === workspaceId);
    for (const n of allNodes) {
      if (n.id !== subject && !scored.some(s => s.answer === n.id)) {
        const sim = this.graph.cosineSimilarity(subject, n.id, workspaceId);
        if (sim > 0.3) scored.push({ answer: n.id, score: sim * 0.5 });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  verify(subject, object, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts && typeof opts === 'object' ? opts.workspaceId : opts);
    return this._verify(subject, object, workspaceId);
  }

  _verify(subject, object, workspaceId) {
    return verifyPath(this.graph, subject, object, workspaceId);
  }

  walk(start, maxDepth, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts && typeof opts === 'object' ? opts.workspaceId : opts);
    return greedyWalk(this.graph, start, maxDepth, workspaceId);
  }
}

module.exports = Dream;
