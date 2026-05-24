const Kernel = require('./kernel');

const TYPE_RELATIONS = new Set(['tür', 'tur', 'tÃ¼r']);
const FACT_RELATIONS = new Set(['özellik', 'ozellik', 'Ã¶zellik', 'yapabilir']);
const OPPOSITE_PREDICATES = new Map([
  ['ucar', 'ucmaz'],
  ['ucmaz', 'ucar'],
  ['yuzer', 'yuzmez'],
  ['yuzmez', 'yuzer'],
  ['sicaktir', 'soguktur'],
  ['soguktur', 'sicaktir'],
  ['canlidir', 'cansizdir'],
  ['cansizdir', 'canlidir'],
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(text) {
  return String(text || '').trim().toLowerCase();
}

function normalizeAscii(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .trim();
}

function parseSimpleTurkishStatement(statement) {
  const raw = normalizeText(statement);
  const negMatch = raw.match(/^(\S+)\s+(.+?)\s+de[gğ]il(?:dir|dır|dur|dür)?$/i);
  if (negMatch) {
    return { subject: negMatch[1], predicate: negMatch[2], isNegated: true };
  }

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  return {
    subject: words[0],
    predicate: words.slice(1).join(' '),
    isNegated: false,
  };
}

class KernelV2 {
  constructor(opts = {}) {
    this.kernel = opts.kernel instanceof Kernel ? opts.kernel : new Kernel(opts);
  }

  get graph() {
    return this.kernel.graph;
  }

  get contractVersion() {
    return this.kernel.contractVersion;
  }

  _ok(type, data = null, evidence = [], meta = {}) {
    if (typeof this.kernel._ok === 'function') {
      return this.kernel._ok(type, data, evidence, meta);
    }
    return {
      ok: true,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: null,
      meta,
    };
  }

  _fail(type, code, message, meta = {}) {
    if (typeof this.kernel._fail === 'function') {
      return this.kernel._fail(type, code, message, meta);
    }
    return {
      ok: false,
      type,
      data: null,
      evidence: [],
      error: { code, message },
      meta,
    };
  }

  _edgeKey(edge) {
    return `${edge.from}|${edge.relation}|${edge.to}`;
  }

  _markTemporalMetadata(source, learnedAt, beforeEdgeMap) {
    const ts = learnedAt || nowIso();
    for (const edge of this.kernel.graph._edges) {
      const key = this._edgeKey(edge);
      const existed = beforeEdgeMap.has(key);

      if (!existed && !edge.createdAt) edge.createdAt = ts;
      edge.updatedAt = ts;
      if (source) edge.source = source;

      if (!Array.isArray(edge.evidence)) edge.evidence = [];
      if (source && !edge.evidence.includes(`source:${source}`)) {
        edge.evidence.push(`source:${source}`);
      }
    }
  }

  learn(text, opts = {}) {
    const source = opts.source || 'user';
    const learnedAt = opts.learnedAt || nowIso();
    const beforeEdgeMap = new Set(this.kernel.graph._edges.map(e => this._edgeKey(e)));
    const result = this.kernel.learn(text);
    this._markTemporalMetadata(source, learnedAt, beforeEdgeMap);
    return this._ok('learn', result.data, result.evidence, {
      ...result.meta,
      source,
      learnedAt,
    });
  }

  learnDocument(text, opts = {}) {
    return this.kernel.learnDocument(text, opts);
  }

  learnFromLLM(text, opts = {}) {
    return this.kernel.learnFromLLM(text, opts);
  }

  ask(question, opts = {}) {
    const result = this.kernel.ask(question, opts);
    return this._ok('ask', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  _isTypeRelation(relation) {
    return TYPE_RELATIONS.has(String(relation || '').toLowerCase());
  }

  _normalizeCopulaTail(predicate) {
    return String(predicate || '')
      .replace(/(?:dır|dir|dur|dür|tır|tir|tur|tür)$/i, '')
      .trim();
  }

  _normalizePredicateToken(predicate) {
    return normalizeAscii(this._normalizeCopulaTail(predicate));
  }

  _inferTypeChain(subject, target, maxDepth = 4) {
    const visited = new Set([subject]);
    const queue = [{ node: subject, path: [] }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.path.length >= maxDepth) continue;

      const edges = this.kernel.graph
        .getEdges(current.node)
        .filter(e => this._isTypeRelation(e.relation));

      for (const edge of edges) {
        if (visited.has(edge.to)) continue;
        const nextPath = [...current.path, edge];

        if (edge.to === target) {
          return nextPath;
        }

        visited.add(edge.to);
        queue.push({ node: edge.to, path: nextPath });
      }
    }

    return null;
  }

  _toPathEvidence(chain) {
    return chain.map(e => ({
      kind: 'path',
      text: `${e.from} --[${e.relation}]--> ${e.to}`,
      confidence: Math.max(0.4, Math.min(0.9, e.weight || 0.5)),
      nodes: [e.from, e.to],
      edges: [{ from: e.from, to: e.to, relation: e.relation }],
    }));
  }

  _aggregatePathConfidence(chain) {
    if (!Array.isArray(chain) || chain.length === 0) return 0.5;
    let total = 0;
    for (const edge of chain) {
      total += Math.max(0.4, Math.min(0.9, edge.weight || 0.5));
    }
    const avg = total / chain.length;
    return Number(Math.max(0.4, Math.min(0.9, avg)).toFixed(2));
  }

  _buildReasoningPath(chain) {
    return chain.map(edge => ({
      from: edge.from,
      relation: edge.relation,
      to: edge.to,
    }));
  }

  _collectTypeTargets(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .filter(edge => this._isTypeRelation(edge.relation))
      .map(edge => edge.to);
  }

  _collectFactTargets(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .filter(edge => FACT_RELATIONS.has(String(edge.relation || '').toLowerCase()))
      .map(edge => ({
        relation: edge.relation,
        target: this._normalizePredicateToken(edge.to),
        rawTarget: edge.to,
        weight: edge.weight,
      }));
  }

  _buildDirectTypeEvidence(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .filter(edge => this._isTypeRelation(edge.relation))
      .map(edge => ({
        kind: 'direct_edge',
        text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
        confidence: Math.max(0.4, Math.min(0.9, edge.weight || 0.5)),
        nodes: [edge.from, edge.to],
        edges: [{ from: edge.from, to: edge.to, relation: edge.relation }],
      }));
  }

  _buildDirectFactEvidence(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .filter(edge => FACT_RELATIONS.has(String(edge.relation || '').toLowerCase()))
      .map(edge => ({
        kind: 'direct_edge',
        text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
        confidence: Math.max(0.4, Math.min(0.9, edge.weight || 0.5)),
        nodes: [edge.from, edge.to],
        edges: [{ from: edge.from, to: edge.to, relation: edge.relation }],
      }));
  }

  verify(statement, opts = {}) {
    const parsed = parseSimpleTurkishStatement(statement);
    if (!parsed) return this.kernel.verify(statement, opts);

    const normalizedTarget = this._normalizeCopulaTail(parsed.predicate);
    if (!normalizedTarget) return this.kernel.verify(statement, opts);
    const normalizedTargetToken = this._normalizePredicateToken(normalizedTarget);

    const knownFacts = this._collectFactTargets(parsed.subject);
    if (parsed.isNegated && knownFacts.length > 0) {
      const directPositive = knownFacts.find(item => item.target === normalizedTargetToken);
      if (directPositive) {
        return this._ok(
          'verify',
          {
            status: 'celiski',
            confidence: Math.max(0.65, Math.min(0.9, directPositive.weight || 0.72)),
            inferred: true,
            contradictionReason: 'negated_statement_conflicts_with_known_fact',
            conflictTarget: normalizedTarget,
            confidenceSource: 'known-fact-conflict',
          },
          this._buildDirectFactEvidence(parsed.subject),
          {
            inferredBy: 'fact-negation-conflict',
          }
        );
      }
    }

    const base = this.kernel.verify(statement, opts);
    if (base?.data?.status !== 'bilinmiyor') return base;

    if (knownFacts.length > 0 && !parsed.isNegated) {
      const opposite = OPPOSITE_PREDICATES.get(normalizedTargetToken);
      if (opposite) {
        const oppositeFact = knownFacts.find(item => item.target === opposite);
        if (oppositeFact) {
          return this._ok(
            'verify',
            {
              status: 'celiski',
              confidence: Math.max(0.65, Math.min(0.9, oppositeFact.weight || 0.72)),
              inferred: true,
              contradictionReason: 'opposite_predicate_conflict',
              conflictTarget: oppositeFact.rawTarget,
              requestedTarget: normalizedTarget,
              confidenceSource: 'opposite-predicate-map',
            },
            this._buildDirectFactEvidence(parsed.subject),
            {
              ...base.meta,
              inferredBy: 'opposite-predicate-conflict',
            }
          );
        }
      }
    }

    if (!parsed.isNegated) {
      const knownTypes = this._collectTypeTargets(parsed.subject);
      if (knownTypes.length > 0 && !knownTypes.includes(normalizedTarget)) {
        return this._ok(
          'verify',
          {
            status: 'celiski',
            confidence: 0.72,
            inferred: true,
            contradictionReason: 'type_mismatch_with_known_types',
            knownTypes,
            requestedType: normalizedTarget,
            confidenceSource: 'known-type-conflict',
          },
          this._buildDirectTypeEvidence(parsed.subject),
          {
            ...base.meta,
            inferredBy: 'type-conflict',
          }
        );
      }
    }

    const chain = this._inferTypeChain(parsed.subject, normalizedTarget, opts.maxDepth || 4);
    if (!chain) return base;

    const evidence = this._toPathEvidence(chain);
    const confidence = this._aggregatePathConfidence(chain);
    const reasoningPath = this._buildReasoningPath(chain);

    if (parsed.isNegated) {
      return this._ok(
        'verify',
        {
          status: 'celiski',
          confidence,
          inferred: true,
          contradictionReason: 'negated_statement_conflicts_with_type_chain',
          reasoningPath,
          pathLength: chain.length,
          confidenceSource: 'path-average',
        },
        evidence,
        {
          ...base.meta,
          inferredBy: 'type-chain-negation',
        }
      );
    }

    return this._ok(
      'verify',
      {
        status: 'dogrulandi',
        confidence,
        inferred: true,
        reasoningPath,
        pathLength: chain.length,
        confidenceSource: 'path-average',
      },
      evidence,
      {
        ...base.meta,
        inferredBy: 'type-chain',
      }
    );
  }

  reason(subject, opts = {}) {
    const result = this.kernel.reason(subject, opts);
    return this._ok('reason', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  compare(left, right, opts = {}) {
    const result = this.kernel.compare(left, right, opts);
    return this._ok('compare', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  dream(opts = {}) {
    const result = this.kernel.dream(opts);
    return this._ok('dream', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  getStats() {
    return this.kernel.graph.getStats();
  }

  entropy() {
    return this.kernel.entropy();
  }

  detectGaps() {
    return this.kernel.detectGaps();
  }

  detectContradictions() {
    return this.kernel.detectContradictions();
  }

  startAutoThink(intervalMs) {
    return this.kernel.startAutoThink(intervalMs);
  }

  stopAutoThink() {
    return this.kernel.stopAutoThink();
  }
}

module.exports = KernelV2;
