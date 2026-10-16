// KernelV2 type-chain inference, evidence collection and verify explanation,
// moved out of kernel.v2.js (#2138). They read the wrapped kernel's graph and
// are installed on KernelV2.prototype, so `this` is the KernelV2 instance.

const { normalizePredicateToken: evidenceNormalizePredicateToken, summarizeEvidence } = require('./kernel-v2-evidence');
const { TYPE_RELATIONS, FACT_RELATIONS } = require('./kernel-v2-native');
const { withManipulationRisk } = require('./text-safety-scorer');

const METHODS = {
  isTypeRelation(relation) {
    return TYPE_RELATIONS.has(String(relation || '').toLowerCase());
  },

  _inferTypeChain(subject, target, maxDepth = 4, workspaceId = 'default') {
    const visited = new Set([subject]);
    const queue = [{ node: subject, path: [] }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.path.length >= maxDepth) continue;

      const edges = this.kernel.graph
        .getEdges(current.node, workspaceId)
        .filter(e => this.isTypeRelation(e.relation));

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
  },

  _buildVerifyExplanation(data, evidenceSummary = [], risk = null) {
    const parts = [];
    const status = data && data.status;

    if (status === 'verified') {
      parts.push(data?.inferred ? 'The statement is supported by an inference chain in the graph.' : 'The statement is directly supported by the graph.');
    } else if (status === 'contradicted') {
      const reason = data?.contradictionReason || 'unspecified';
      parts.push(`The statement was found contradictory (${reason}).`);
    } else {
      parts.push('Not enough evidence was found for the statement.');
    }

    if (Array.isArray(data?.reasoningPath) && data.reasoningPath.length > 0) {
      const pathText = data.reasoningPath
        .map(step => `${step.from} -> ${step.relation} -> ${step.to}`)
        .join(' | ');
      parts.push(`Path followed: ${pathText}.`);
    } else if (evidenceSummary.length > 0) {
      parts.push(`Evidence summary: ${evidenceSummary.join(' | ')}.`);
    }

    if (risk?.manipulation) {
      const labels = Array.isArray(risk.labels) && risk.labels.length > 0
        ? risk.labels.join(', ')
        : 'manipulation';
      parts.push(`Risk markers: ${labels}.`);
    }

    return parts.join(' ');
  },

  _withVerifyDetails(result, risk = null) {
    const hasDataObject = result && result.data && typeof result.data === 'object' && !Array.isArray(result.data);
    const data = hasDataObject ? { ...result.data } : result.data;
    const reasoningPath = Array.isArray(data?.reasoningPath) ? data.reasoningPath : [];
    const evidenceSummary = summarizeEvidence(result?.evidence || [], reasoningPath);
    const explanation = this._buildVerifyExplanation(data, evidenceSummary, risk);
    const enriched = hasDataObject
      ? {
          ...result,
          data: {
            ...data,
            evidenceSummary,
            explanation,
          },
        }
      : result;
    return withManipulationRisk(enriched, risk);
  },

  _collectTypeTargets(subject, workspaceId = 'default') {
    return this.kernel.graph
      .getEdges(subject, workspaceId)
      .filter(edge => this.isTypeRelation(edge.relation))
      .map(edge => edge.to);
  },

  collectFactTargets(subject, workspaceId = 'default') {
    return this.kernel.graph
      .getEdges(subject, workspaceId)
      .filter(edge => FACT_RELATIONS.has(String(edge.relation || '').toLowerCase()))
      .map(edge => ({
        relation: edge.relation,
        target: evidenceNormalizePredicateToken(edge.to),
        rawTarget: edge.to,
        weight: edge.weight,
      }));
  },

  _collectPredicateTargets(subject, workspaceId = 'default') {
    return this.kernel.graph
      .getEdges(subject, workspaceId)
      .map(edge => ({
        relation: edge.relation,
        target: evidenceNormalizePredicateToken(edge.to),
        rawTarget: edge.to,
        weight: edge.weight,
      }));
  },

  buildDirectTypeEvidence(subject, workspaceId = 'default') {
    return this.kernel.graph
      .getEdges(subject, workspaceId)
      .filter(edge => this.isTypeRelation(edge.relation))
      .map(edge => ({
        kind: 'direct_edge',
        text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
        confidence: Math.max(0.4, Math.min(0.9, edge.weight || 0.5)),
        nodes: [edge.from, edge.to],
        edges: [{ from: edge.from, to: edge.to, relation: edge.relation }],
      }));
  },

  buildDirectFactEvidence(subject, workspaceId = 'default') {
    return this.kernel.graph
      .getEdges(subject, workspaceId)
      .filter(edge => FACT_RELATIONS.has(String(edge.relation || '').toLowerCase()))
      .map(edge => ({
        kind: 'direct_edge',
        text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
        confidence: Math.max(0.4, Math.min(0.9, edge.weight || 0.5)),
        nodes: [edge.from, edge.to],
        edges: [{ from: edge.from, to: edge.to, relation: edge.relation }],
      }));
  },

  _buildPredicateEvidence(subject, workspaceId = 'default') {
    return this.kernel.graph
      .getEdges(subject, workspaceId)
      .map(edge => ({
        kind: 'direct_edge',
        text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
        confidence: Math.max(0.4, Math.min(0.9, edge.weight || 0.5)),
        nodes: [edge.from, edge.to],
        edges: [{ from: edge.from, to: edge.to, relation: edge.relation }],
      }));
  },
};

// Class methods are non-enumerable; installing these the same way keeps
// `for...in`, spreads and Object.keys over a KernelV2 unchanged.
function install(KernelV2) {
  for (const [name, fn] of Object.entries(METHODS)) {
    Object.defineProperty(KernelV2.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false });
  }
}

module.exports = { install };
