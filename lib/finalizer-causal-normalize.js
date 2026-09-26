// Normalisers for a causal simulation result's outcomes, risks, evidence,
// affected nodes, chains and traversal. Moved out of finalizer.js (#2170).

const { cloneValue, dedupeStable, extractText, normalizeEvidence, normalizeText } = require('./finalizer-text');

function normalizeCausalOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;
  return {
    chain: Array.isArray(outcome.chain) ? outcome.chain.map(e => ({
      from: e.from || '',
      to: e.to || '',
      relation: e.relation || '',
      strength: typeof e.strength === 'number' ? e.strength : 0.5,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
    })) : [],
    impact: typeof outcome.impact === 'number' ? outcome.impact : 0.5,
    confidence: typeof outcome.confidence === 'number' ? outcome.confidence : 0.5,
    description: normalizeText(outcome.description || ''),
  };
}

function normalizeCausalRisk(risk) {
  if (!risk || typeof risk !== 'object') return null;
  return {
    chain: Array.isArray(risk.chain) ? risk.chain : [],
    severity: risk.severity === 'critical'
      ? 'critical'
      : (risk.severity === 'high'
        ? 'high'
        : (risk.severity === 'low'
          ? 'low'
          : (risk.severity === 'unknown'
            ? 'unknown'
            : 'medium'))),
    description: normalizeText(risk.description || ''),
  };
}

function normalizeCausalEvidenceItem(item) {
  if (item === undefined || item === null) return null;
  if (typeof item === 'string') {
    return { type: 'text', value: normalizeText(item) };
  }
  if (typeof item !== 'object') {
    return { type: 'value', value: item };
  }
  const normalized = cloneValue(item);
  if (Object.prototype.hasOwnProperty.call(normalized, 'description')) {
    normalized.description = normalizeText(normalized.description || '');
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'value')) {
    normalized.value = extractText(normalized.value) || normalized.value;
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'confidence')) {
    const num = Number(normalized.confidence);
    normalized.confidence = Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
  }
  return normalized;
}

function normalizeCausalEvidence(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return dedupeStable(items.map(normalizeCausalEvidenceItem).filter(Boolean));
}

function normalizeAffectedNode(node) {
  if (!node || typeof node !== 'object') return null;
  return {
    nodeId: normalizeText(node.nodeId || node.id || ''),
    label: normalizeText(node.label || node.nodeId || node.id || ''),
    relation: normalizeText(node.relation || ''),
    effect: normalizeText(node.effect || ''),
    impact: typeof node.impact === 'number' ? Math.max(0, Math.min(1, node.impact)) : 0,
    confidence: typeof node.confidence === 'number' ? Math.max(0, Math.min(1, node.confidence)) : 0,
    severity: node.severity === 'critical'
      ? 'critical'
      : node.severity === 'high'
        ? 'high'
        : node.severity === 'medium'
          ? 'medium'
          : node.severity === 'low'
            ? 'low'
            : 'unknown',
    path: Array.isArray(node.path) ? dedupeStable(node.path.map(step => normalizeText(step)).filter(Boolean)) : [],
  };
}

function normalizeCausalChain(chain) {
  if (!Array.isArray(chain)) return [];
  return chain.map(step => {
    if (!step || typeof step !== 'object') return null;
    return {
      from: normalizeText(step.from || ''),
      to: normalizeText(step.to || ''),
      relation: normalizeText(step.relation || ''),
      strength: typeof step.strength === 'number' ? Math.max(0, Math.min(1, step.strength)) : 0.5,
      confidence: typeof step.confidence === 'number' ? Math.max(0, Math.min(1, step.confidence)) : 0.5,
      source: normalizeText(step.source || 'manual'),
      source_ref: normalizeText(step.source_ref || ''),
      evidence: normalizeEvidence(step.evidence),
      evidence_type: normalizeText(step.evidence_type || ''),
      created_at: normalizeText(step.created_at || ''),
      updated_at: normalizeText(step.updated_at || ''),
    };
  }).filter(Boolean);
}

function normalizeCausalTraversal(traversal, fallback = {}) {
  const rawChain = Array.isArray(traversal)
    ? traversal
    : (Array.isArray(traversal?.chain) ? traversal.chain : []);
  const chain = rawChain.map(normalizeCausalChain).filter(path => Array.isArray(path) && path.length > 0);
  const visited = Array.isArray(traversal?.visited)
    ? dedupeStable(traversal.visited.map(item => normalizeText(item)).filter(Boolean))
    : [];
  const loops = Array.isArray(traversal?.loops)
    ? traversal.loops
        .map(loop => Array.isArray(loop) ? loop.map(item => normalizeText(item)).filter(Boolean) : [])
        .filter(loop => loop.length > 0)
    : [];
  const stoppedReason = normalizeText(traversal?.stoppedReason || fallback.stoppedReason || (chain.length > 0 ? 'exhausted' : 'insufficient-data'));
  const maxDepthValue = Number.isFinite(traversal?.maxDepth)
    ? traversal.maxDepth
    : (Number.isFinite(fallback.maxDepth) ? fallback.maxDepth : 0);
  const confidenceValue = Number.isFinite(traversal?.confidence)
    ? traversal.confidence
    : (Number.isFinite(fallback.confidence) ? fallback.confidence : 0);

  return {
    chain,
    start: normalizeText(traversal?.start || fallback.start || fallback.nodeId || ''),
    visited,
    loops,
    stoppedReason,
    maxDepth: maxDepthValue,
    confidence: confidenceValue,
  };
}

module.exports = {
  normalizeCausalOutcome,
  normalizeCausalRisk,
  normalizeCausalEvidenceItem,
  normalizeCausalEvidence,
  normalizeAffectedNode,
  normalizeCausalChain,
  normalizeCausalTraversal,
};
