class VerifyService {
  constructor(kernel) {
    this.kernel = kernel;
  }

  verify(statement, opts = {}) {
    const workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim()
      ? opts.workspaceId.trim()
      : 'default';
    const numericComparison = this.kernel._parseNumericComparison(statement);
    if (numericComparison) {
      return this.kernel._ok('verify', {
        status: numericComparison.ok ? 'dogrulandi' : 'celiski',
        confidence: 0.98,
      }, [{
        kind: numericComparison.ok ? 'direct_edge' : 'contradiction',
        text: `Sayısal karşılaştırma: "${numericComparison.left} ${numericComparison.operator} ${numericComparison.right}"`,
        confidence: 0.98,
        nodes: [String(numericComparison.left), String(numericComparison.right)],
        edges: [],
      }]);
    }

    const parts = statement.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return this.kernel._ok('verify', { status: 'bilinmiyor', confidence: 0 }, []);
    }

    const subject = this.kernel.normalizeWord(parts[0]);
    const subjectNode = this.kernel.graph.getNode(subject, workspaceId);
    if (!subjectNode) {
      return this.kernel._ok('verify', { status: 'bilinmiyor', confidence: 0 }, []);
    }

    const edges = this.kernel.graph.getEdges(subject, workspaceId);
    const predicate = parts.slice(1).join(' ');

    const predicateNumericComparison = this.kernel._parseNumericComparison(predicate);
    if (predicateNumericComparison) {
      return this.kernel._ok('verify', {
        status: predicateNumericComparison.ok ? 'dogrulandi' : 'celiski',
        confidence: 0.95,
      }, [{
        kind: predicateNumericComparison.ok ? 'direct_edge' : 'contradiction',
        text: `Sayısal karşılaştırma: "${predicateNumericComparison.left} ${predicateNumericComparison.operator} ${predicateNumericComparison.right}"`,
        confidence: 0.95,
        nodes: [subject, String(predicateNumericComparison.left), String(predicateNumericComparison.right)],
        edges: [],
      }]);
    }

    const negMatch = predicate.match(/^(.*?)\s+(de[ğg]il|de[ğg]ildir|not)\s*$/i);
    if (negMatch) {
      const positive = negMatch[1].trim();
      if (positive) {
        const posNorm = this.kernel.normalizeWord(positive);
        const posEdge = edges.find(e => e.to === posNorm || e.to.includes(posNorm));
        if (posEdge) {
          return this.kernel._ok('verify', { status: 'celiski', confidence: 0.85 }, [{
            kind: 'contradiction',
            text: `${subject} --[${posEdge.relation}]--> ${posEdge.to} var ama ifade olumsuz: "${predicate}"`,
            confidence: 0.85,
            nodes: [subject, posEdge.to],
            edges: [{ from: subject, to: posEdge.to, relation: posEdge.relation }],
          }]);
        }
      }
    }

    const directEdge = edges.find(e => predicate.includes(e.to) || e.to === predicate);
    if (directEdge) {
      const confidence = Math.min(0.95, (directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.4);
      return this.kernel._ok('verify', { status: 'dogrulandi', confidence }, [this.kernel._edgeEvidence(directEdge, 'direct_edge', confidence)]);
    }

    const cons = this.kernel.detectContradictions(subject, workspaceId);
    const subjCons = cons.filter(c => c.node === subject);
    if (subjCons.length > 0) {
      const evidence = subjCons.map(c => this.kernel._contradictionEvidence(c));
      return this.kernel._ok('verify', { status: 'celiski', confidence: 0.7 }, evidence);
    }

    const rawTarget = parts[parts.length - 1];
    const cleanTarget = rawTarget.replace(/(d\u0131r|dir|dur|d\u00fcr|t\u0131r|tir|tur|t\u00fcr)$/i, '');
    const target = this.kernel.normalizeWord(cleanTarget || rawTarget);
    if (target !== subject) {
      const foundPath = this.kernel._findPath(subject, target, new Set(), [], 4, workspaceId);
      if (foundPath) {
        return this.kernel._ok('verify', { status: 'dogrulandi', confidence: 0.5 }, [this.kernel._pathEvidence(foundPath, 'path', 0.5)]);
      }
    }

    const stmtNums = predicate.match(/\d+/g);
    if (stmtNums && edges.length > 0) {
      for (const edge of edges) {
        const edgeNums = String(edge.to).match(/\d+/g);
        if (edgeNums) {
          const mismatch = stmtNums.some((n, i) => edgeNums[i] && n !== edgeNums[i]);
          if (mismatch) {
            const stmtWords = parts.slice(1).filter(p => !/^\d+$/.test(p) && p.length > 1);
            const hasTextOverlap = stmtWords.some(w => edge.to.includes(w));
            if (hasTextOverlap) {
              return this.kernel._ok('verify', { status: 'celiski', confidence: 0.75 }, [{
                kind: 'contradiction',
                text: `Sayısal çelişki: "${predicate}" ifadesinde ${stmtNums.join(',')} ama "${edge.to}" bilgisinde ${edgeNums.join(',')}`,
                confidence: 0.75,
                nodes: [subject, edge.to],
                edges: [{ from: subject, to: edge.to, relation: edge.relation }],
              }]);
            }
          }
        }
      }
    }

    for (const word of parts.slice(1)) {
      const w = this.kernel.normalizeWord(word);
      const match = edges.find(e => e.to === w || e.to.includes(w));
      if (match) {
        return this.kernel._ok('verify', { status: 'dogrulandi', confidence: 0.35 }, [this.kernel._edgeEvidence(match, 'partial_match', 0.35)]);
      }
    }

    return this.kernel._ok('verify', { status: 'bilinmiyor', confidence: 0 }, []);
  }

  detectContradictions(subject = '', workspaceId = 'default') {
    const scope = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : 'default';
    const allNodes = Object.values(this.kernel.graph.getNodes(scope)).filter(node => !subject || node.id === subject);
    const contradictions = [];

    for (const node of allNodes) {
      const edges = this.kernel.graph.getEdges(node.id, scope);
      const typeEdges = edges.filter(e => e.relation === 'tür');
      if (typeEdges.length > 1) {
        contradictions.push({
          type: 'çoklu-tür',
          node: node.id,
          targets: typeEdges.map(e => e.to),
          confidence: Math.min(0.6, typeEdges.length * 0.15),
          edges: typeEdges,
          message: 'multi type detected: ' + typeEdges.map(e => e.to).join(', '),
        });
      }
    }

    for (const node of allNodes) {
      const nodeEdges = this.kernel.graph.getEdges(node.id, scope);
      for (const edge of nodeEdges) {
        if (edge.relation !== 'tür') continue;
        const backEdge = this.kernel.graph.getEdge(edge.to, node.id, 'tür', scope);
        if (backEdge && !contradictions.some(c => c.type === 'döngü' && c.node === node.id)) {
          contradictions.push({
            type: 'döngü',
            node: node.id,
            targets: [edge.to],
            confidence: 0.7,
            edges: [edge, backEdge],
            message: 'cycle detected between ' + node.id + ' and ' + edge.to,
          });
        }
      }
    }

    for (const node of allNodes) {
      const edges = this.kernel.graph.getEdges(node.id, scope);
      const degilEdges = edges.filter(e => e.relation === 'değil');
      if (degilEdges.length === 0) continue;
      const otherEdges = edges.filter(e => e.relation !== 'değil' && e.relation !== 'benzer' && e.relation !== 'hipotez');
      for (const degil of degilEdges) {
        const degilCore = degil.to.replace(/(?:maz|mez|mamak|memek|değildir|değil)$/i, '').trim();
        for (const other of otherEdges) {
          const otherCore = other.to.replace(/(?:maz|mez|mamak|memek|değildir|değil|yapabilir|yapamaz|edebilir|edemez)$/i, '').trim();
          if (degilCore.length > 3 && otherCore.length > 3 && (otherCore.includes(degilCore.slice(0, 8)) || degilCore.includes(otherCore.slice(0, 8)))) {
            contradictions.push({
              type: 'negasyon',
              node: node.id,
              targets: [degil.to, other.to],
              confidence: 0.8,
              message: 'negation conflict for ' + node.id,
              edges: [degil, other],
            });
          }
        }
      }
    }

    for (const node of allNodes) {
      const edges = this.kernel.graph.getEdges(node.id, scope);
      const edgesWithNums = [];
      for (const e of edges) {
        if (e.relation === 'hipotez') continue;
        const nums = this._extractNumbers(e.to);
        if (nums) edgesWithNums.push({ edge: e, nums });
      }
      if (edgesWithNums.length < 2) continue;
      for (let i = 0; i < edgesWithNums.length; i++) {
        for (let j = i + 1; j < edgesWithNums.length; j++) {
          if (edgesWithNums[i].nums === edgesWithNums[j].nums) continue;
          const coreI = this._getTextCore(edgesWithNums[i].edge.to);
          const coreJ = this._getTextCore(edgesWithNums[j].edge.to);
          const normI = coreI.replace(/\s+/g, ' ');
          const normJ = coreJ.replace(/\s+/g, ' ');
          const shorter = normI.length <= normJ.length ? normI : normJ;
          const longer = normI.length <= normJ.length ? normJ : normI;
          if (shorter.length < 5) continue;
          if (!longer.includes(shorter)) continue;
          contradictions.push({
            type: 'sayısal',
            node: node.id,
            targets: [edgesWithNums[i].edge.to, edgesWithNums[j].edge.to],
            confidence: 0.75,
            message: 'numeric conflict for ' + node.id,
            edges: [edgesWithNums[i].edge, edgesWithNums[j].edge],
          });
        }
      }
    }

    for (const node of allNodes) {
      const edges = this.kernel.graph.getEdges(node.id, scope);
      for (const e of edges) {
        if (e.relation === 'benzer' || e.relation === 'hipotez') continue;
        if (e.celiski || (e.weight !== undefined && e.weight < 0.3)) {
          contradictions.push({
            type: 'düşük-ağırlık',
            node: node.id,
            targets: [e.to],
            confidence: 0.6,
            message: 'low weight edge for ' + node.id,
            edges: [e],
          });
        }
      }
    }

    return contradictions;
  }

  _parseNumericComparison(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const match = raw.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*(==|=|!=|<>|<=|>=|<|>)\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (!match) return null;

    const left = Number(String(match[1]).replace(',', '.'));
    const operator = match[2];
    const right = Number(String(match[3]).replace(',', '.'));
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;

    let ok = false;
    switch (operator) {
      case '=':
      case '==':
        ok = left === right;
        break;
      case '!=':
      case '<>':
      case '?':
        ok = left !== right;
        break;
      case '<':
        ok = left < right;
        break;
      case '>':
        ok = left > right;
        break;
      case '<=':
        ok = left <= right;
        break;
      case '>=':
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
      text: raw,
    };
  }

  _contradictionEvidence(contradiction) {
    const targets = Array.isArray(contradiction.targets) ? contradiction.targets : [];
    const edges = Array.isArray(contradiction.edges)
      ? contradiction.edges.map(edge => this.kernel._edgeRef(edge))
      : targets.map(to => ({ from: contradiction.node, to, relation: contradiction.relation || 'tür' }));
    return {
      kind: 'contradiction',
      text: contradiction.message || `${contradiction.node} conflicts with ${targets.join(', ')}`,
      confidence: Math.max(0, Math.min(1, contradiction.confidence || 0.7)),
      nodes: [contradiction.node, ...targets],
      edges,
    };
  }

  _extractNumbers(text) {
    const turkishNums = {
      'bir':1,'iki':2,'uc':3,'dort':4,'bes':5,'alti':6,'yedi':7,'sekiz':8,'dokuz':9,
      'on':10,'yirmi':20,'otuz':30,'kirk':40,'elli':50,'altmis':60,'yetmis':70,'seksen':80,'doksan':90,
      'yuz':100,'bin':1000,
    };
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const nums = [];
    for (const w of words) {
      if (/^\d+$/.test(w)) nums.push(parseInt(w, 10));
      else if (turkishNums[w] !== undefined) nums.push(turkishNums[w]);
    }
    const digitMatches = text.match(/\d+/g);
    if (digitMatches) for (const d of digitMatches) nums.push(Number(d));
    if (nums.length === 0) return null;
    return [...new Set(nums)].sort((a,b)=>a-b).join(',');
  }

  _getTextCore(text) {
    const turkishNums = {
      'bir':1,'iki':2,'uc':3,'dort':4,'bes':5,'alti':6,'yedi':7,'sekiz':8,'dokuz':9,
      'on':10,'yirmi':20,'otuz':30,'kirk':40,'elli':50,'altmis':60,'yetmis':70,'seksen':80,'doksan':90,
      'yuz':100,'bin':1000,
    };
    let s = text.toLowerCase();
    for (const [word, num] of Object.entries(turkishNums)) {
      s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), String(num));
    }
    return s.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  }
}

module.exports = VerifyService;
