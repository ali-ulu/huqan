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

    const nodes = Object.keys(this.graph._nodes);
    if (nodes.length < 2) return null;

    // Random walk'lar
    const walks = [];
    for (const id of nodes) {
      for (let w = 0; w < walksPerNode; w++) {
        walks.push(this._biasedWalk(id, walkLength, p, q));
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

    // [-1, 1] aralığına normalize
    return (h2 / 2147483648) - 1;
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

  _biasedWalk(start, length, p, q) {
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

      let r    = Math.random() * total;
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

  _calculateCompositeScore(hyp) {
    const confidence = hyp.confidence || 0.3;

    let novelty = 0;
    if (hyp.type === 'çelişki') {
      novelty = 1.0;
    } else if (hyp.from && hyp.to) {
      const exists = this.graph.getEdges(hyp.from).some(e => e.to === hyp.to)
                  || this.graph.getEdges(hyp.to).some(e => e.to === hyp.from);
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
      usefulness,
    };
  }

  // ─── Dream (Hipotez Üretimi) ──────────────────────────────────────────────

  dream() {
    this._emit('beforeDream', {});
    const nodes = Object.values(this.graph._nodes);
    if (nodes.length < 2) {
      this._emit('afterDream', { hypotheses: [] });
      return [];
    }

    const hypotheses = [];
    this._findSimilarityHypotheses(nodes, hypotheses);
    this._findTransitiveHypotheses(nodes, hypotheses);
    this._findGapHypotheses(nodes, hypotheses);
    this._findSymmetryHypotheses(nodes, hypotheses);
    this._findContradictionHypotheses(nodes, hypotheses);

    const scored = hypotheses.map(h => ({
      ...h,
      ...this._calculateCompositeScore(h),
    }));

    const contradictions = scored.filter(h => h.type === 'çelişki');
    const others = scored.filter(h => h.type !== 'çelişki');

    contradictions.sort((a, b) => b.confidence - a.confidence);
    others.sort((a, b) => b.score - a.score);

    const result = [...contradictions, ...others].slice(0, 10);

    this._emit('afterDream', { hypotheses: result });
    return result;
  }

  _findSimilarityHypotheses(nodes, hypotheses) {
    const checked = new Set();
    let added = 0;
    for (let i = 0; i < nodes.length && added < 50; i++) {
      for (let j = i + 1; j < nodes.length && added < 50; j++) {
        const a = nodes[i], b = nodes[j];
        const key = `${a.id}|${b.id}`;
        if (checked.has(key)) continue;
        checked.add(key);

        const aEdges   = this.graph.getEdges(a.id);
        const bEdges   = this.graph.getEdges(b.id);
        const aTargets = new Set(aEdges.map(e => e.to));
        const bTargets = new Set(bEdges.map(e => e.to));
        const common   = [...aTargets].filter(t => bTargets.has(t));

        if (common.length > 0) {
          const existing = this.graph.getEdge(a.id, b.id, 'benzer')
                        || this.graph.getEdge(b.id, a.id, 'benzer');
          if (!existing) {
            const avgWeight = common.reduce((s, t) => {
              const ae = aEdges.find(e => e.to === t);
              const be = bEdges.find(e => e.to === t);
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

        const sim = this.graph.cosineSimilarity(a.id, b.id);
        if (sim > 0.5) {
          const hasEdge = this.graph.hasAnyEdge(a.id, b.id)
                       || this.graph.hasAnyEdge(b.id, a.id);
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

  _findTransitiveHypotheses(nodes, hypotheses) {
    let added = 0;
    for (const node of nodes) {
      if (added >= 50) break;
      const edges = this.graph.getEdges(node.id);
      for (const edge of edges) {
        if (added >= 50) break;
        const transEdges = this.graph.getEdges(edge.to);
        for (const te of transEdges) {
          if (added >= 50) break;
          if (te.to === node.id) continue;
          const existing = this.graph.getEdge(node.id, te.to, edge.relation);
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

  _findGapHypotheses(nodes, hypotheses) {
    const gaps = this.kernel.detectGaps();
    if (gaps.length === 0 || nodes.length < 2) return;

    let added = 0;
    for (const gapId of gaps) {
      if (added >= 50) break;
      const gapNode = this.graph.getNode(gapId);
      if (!gapNode) continue;

      let best = null, bestSim = 0;
      for (const n of nodes) {
        if (n.id === gapId) continue;
        const sim = this.graph.cosineSimilarity(gapId, n.id);
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

  _findSymmetryHypotheses(nodes, hypotheses) {
    let added = 0;
    for (const node of nodes) {
      if (added >= 50) break;
      const edges = this.graph.getEdges(node.id);
      for (const edge of edges) {
        if (added >= 50) break;
        const reverse    = this.graph.getEdge(edge.to, node.id, edge.relation);
        const reverseAny = this.graph.hasAnyEdge(edge.to, node.id);
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

  _findContradictionHypotheses(nodes, hypotheses) {
    if (typeof this.kernel.detectContradictions !== 'function') return;
    try {
      const contradictions = this.kernel.detectContradictions();
      let added = 0;
      for (const c of contradictions) {
        if (added >= 50) break;
        hypotheses.push({
          type: 'çelişki',
          node: c.node,
          targets: c.targets,
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
