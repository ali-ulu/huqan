const { normalizeWorkspaceId, nodeStorageKey } = require('./lib/graph-record-utils');
const { isSymmetricRelation, nodesAreDisjoint, isEligibleHypothesisNode } = require('./lib/dream-hypothesis-semantics');
const {
  projectionWeight,
  nodeSignatureWeight,
  biasedWalk,
  runEmbedding,
} = require('./lib/dream-embedding');

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
        // #1643 follow-up: the source is gated by the caller, but hop targets
        // come straight from the graph. A chain hop through or into debris
        // ("{", "[],") yields a syntactically valid, semantically empty
        // proposal -- gate both hops.
        if (!isEligibleHypothesisNode(edge.to)) continue;
        const transEdges = context.outEdges.get(edge.to) || [];
        for (const te of transEdges) {
          if (added >= 50) break;
          if (!this._consumeDreamWork(context)) return;
          if (te.to === node.id) continue;
          if (!isEligibleHypothesisNode(te.to)) continue;
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
    const visited = new Set();
    const path    = [];
    const found   = this._dfs(subject, object, visited, path, 5, workspaceId);
    if (found) {
      return { valid: true, confidence: this._pathConfidence(path, workspaceId), path };
    }
    return { valid: false, confidence: 0, path: [] };
  }

  _dfs(current, target, visited, path, depth, workspaceId) {
    if (depth <= 0 || visited.has(current)) return false;
    visited.add(current);
    path.push(current);
    if (current === target) return true;

    for (const e of this.graph.getEdges(current, workspaceId)) {
      if (!visited.has(e.to) && this._dfs(e.to, target, visited, path, depth - 1, workspaceId)) return true;
    }
    for (const ie of this.graph.getInEdges(current, workspaceId)) {
      if (!visited.has(ie.from) && this._dfs(ie.from, target, visited, path, depth - 1, workspaceId)) return true;
    }

    path.pop();
    visited.delete(current);
    return false;
  }

  _pathConfidence(path, workspaceId) {
    let conf = 1;
    for (let i = 0; i < path.length - 1; i++) {
      const edge = this.graph.getEdges(path[i], workspaceId).find(e => e.to === path[i + 1])
                || this.graph.getInEdges(path[i], workspaceId).find(e => e.from === path[i + 1]);
      if (edge) conf *= edge.weight;
    }
    return conf;
  }

  walk(start, maxDepth, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts && typeof opts === 'object' ? opts.workspaceId : opts);
    const path    = [start];
    const visited = new Set([start]);
    let current   = start;

    for (let i = 0; i < maxDepth; i++) {
      const edges = this.graph.getEdges(current, workspaceId).filter(e => !visited.has(e.to));
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
