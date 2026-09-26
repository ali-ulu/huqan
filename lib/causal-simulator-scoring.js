// Relation profiles and the pure scoring helpers CausalSimulator uses, moved
// out of causalSimulator.js (#2187).

const RELATION_PROFILES = Object.freeze({
  CAUSES: {
    effect: 'direct',
    impactBias: 1,
    riskBias: 1,
    severityBias: 0.03,
  },
  PREVENTS: {
    effect: 'blocking',
    impactBias: 1.05,
    riskBias: 1.18,
    severityBias: 0.12,
  },
  ENABLES: {
    effect: 'enabling',
    impactBias: 0.9,
    riskBias: 0.82,
    severityBias: -0.05,
  },
  DEPENDS_ON: {
    effect: 'dependency',
    impactBias: 0.95,
    riskBias: 1,
    severityBias: 0.07,
  },
  LEADS_TO: {
    effect: 'downstream',
    impactBias: 1,
    riskBias: 1,
    severityBias: 0.02,
  },
});

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function average(values) {
  const filtered = values.filter(value => Number.isFinite(value));
  if (filtered.length === 0) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];
}

function relationProfile(relation) {
  return RELATION_PROFILES[relation] || RELATION_PROFILES.CAUSES;
}

function severityFromScore(score, profile) {
  const adjusted = clamp01(score + (profile.severityBias || 0));
  if (adjusted >= 0.88) return 'critical';
  if (adjusted >= 0.7) return 'high';
  if (adjusted >= 0.5) return 'medium';
  if (adjusted >= 0.3) return 'low';
  return 'unknown';
}

function rankSeverity(severity) {
  return {
    unknown: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  }[severity] ?? 0;
}

function normalizeStep(step) {
  return {
    from: step.from || '',
    to: step.to || '',
    relation: step.relation || '',
    strength: typeof step.strength === 'number' ? step.strength : 0.5,
    confidence: typeof step.confidence === 'number' ? step.confidence : 0.5,
    source: step.source || 'manual',
    source_ref: step.source_ref || '',
    session_id: step.session_id || '',
    evidence: Array.isArray(step.evidence) ? [...step.evidence] : [],
    evidence_type: step.evidence_type || '',
    created_at: step.created_at || '',
    updated_at: step.updated_at || '',
  };
}

function describeRelation(relation) {
  switch (relation) {
    case 'CAUSES':
      return 'causes';
    case 'PREVENTS':
      return 'prevents';
    case 'ENABLES':
      return 'enables';
    case 'DEPENDS_ON':
      return 'depends on';
    case 'LEADS_TO':
      return 'leads to';
    default:
      return relation.toLowerCase().replace(/_/g, ' ');
  }
}

function collectEvidence(chain) {
  return uniqueStrings(chain.flatMap(step => (Array.isArray(step.evidence) ? step.evidence : [])));
}

function findScopedNode(nodes, nodeId) {
  if (!nodes || typeof nodes !== 'object') return null;
  if (nodes[nodeId]?.id === nodeId) return nodes[nodeId];
  return Object.values(nodes).find(node => node?.id === nodeId) || null;
}

function cloneState(value) {
  if (typeof value === 'undefined') return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return String(value); }
}

function stateImpact(changeType, newState) {
  const type = String(changeType || 'unknown').trim().toLowerCase();
  if (type === 'remove') return 0;
  if (type === 'add') return 1;
  if (type !== 'modify') return 1;
  if (typeof newState === 'boolean') return newState ? 1 : 0;
  if (!newState || typeof newState !== 'object') return 1;
  for (const key of ['enabled', 'active', 'available']) {
    if (typeof newState[key] === 'boolean') return newState[key] ? 1 : 0;
  }
  const state = String(newState.status || newState.state || '').trim().toLowerCase();
  if (['disabled', 'inactive', 'removed', 'offline', 'blocked', 'off'].includes(state)) return 0;
  return 1;
}

function simulationOverlay(changeType, newState) {
  const type = String(changeType || 'unknown').trim().toLowerCase() || 'unknown';
  const impact = stateImpact(type, newState);
  return {
    changeType: type,
    stateImpact: impact,
    effect: type === 'remove' || impact === 0 ? 'suppressed' : type === 'add' ? 'activated' : type === 'modify' ? 'modified' : 'observed',
    newState: cloneState(newState),
  };
}

/**
 * Causal Simulator for v0.7
 * Simulates "what-if" scenarios using causal chains
 */

module.exports = {
  average,
  clamp01,
  collectEvidence,
  describeRelation,
  findScopedNode,
  normalizeStep,
  rankSeverity,
  relationProfile,
  severityFromScore,
  simulationOverlay,
  uniqueStrings,
};
