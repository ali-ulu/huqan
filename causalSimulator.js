const { Graph, CAUSAL_RELATIONS } = require('./graph');

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

/**
 * Causal Simulator for v0.7
 * Simulates "what-if" scenarios using causal chains
 */
class CausalSimulator {
  constructor(graph) {
    if (!graph || !(graph instanceof Graph)) {
      throw new Error('CausalSimulator requires a Graph instance');
    }
    this.graph = graph;
  }

  /**
   * Simulate a change and return causal consequences
   * @param {object} opts
   * @param {string} opts.action - Action description
   * @param {string} opts.nodeId - Node to simulate change on
   * @param {string} opts.changeType - Type of change (add, remove, modify)
   * @param {object} opts.newState - New state if modify
   * @param {number} opts.maxDepth - Maximum causal chain depth (default: 10)
   * @returns {object} Simulation result
   */
  simulateChange(opts = {}) {
    const { action, nodeId, changeType, newState, maxDepth = 10 } = opts;

    if (!nodeId) {
      throw new Error('simulateChange requires nodeId');
    }

    const node = this.graph._nodes[nodeId];
    if (!node) {
      return {
        ok: false,
        mode: 'missing-node',
        error: `Node '${nodeId}' not found in graph`,
        action: action || `Simulate change on ${nodeId}`,
        input: {
          action: action || `Simulate change on ${nodeId}`,
          nodeId,
          changeType: changeType || 'unknown',
          newState: typeof newState === 'undefined' ? null : newState,
          maxDepth,
        },
        affectedNodes: [],
        evidence: [],
        unknowns: [`Node '${nodeId}' not found in graph`],
        recommendation: 'Node not found; seed the graph before simulating.',
        outcomes: [],
        risks: [],
        confidence: 0,
        causalChains: 0,
        causalChainDetails: [],
        traversal: null,
        summary: `Node '${nodeId}' not found in graph`,
      };
    }

    const traversal = this.graph.getCausalChain(nodeId, { maxDepth });
    const causalChains = Array.isArray(traversal)
      ? traversal
      : (traversal && Array.isArray(traversal.chain) ? traversal.chain : []);

    const outcomes = [];
    const risks = [];
    const affectedNodes = [];
    const evidence = [];
    const unknowns = [];

    let totalConfidence = 0;
    let confidenceCount = 0;

    for (const rawChain of causalChains) {
      if (!Array.isArray(rawChain) || rawChain.length === 0) {
        continue;
      }

      const chain = rawChain.map(normalizeStep);
      const terminalEdge = chain[chain.length - 1];
      const profile = relationProfile(terminalEdge.relation);
      const chainStrength = average(chain.map(step => clamp01(step.strength)));
      const chainConfidence = average(chain.map(step => clamp01(step.confidence)));
      const lengthPenalty = Math.max(0.55, 1 - Math.max(0, chain.length - 1) * 0.08);
      const impact = clamp01(chainStrength * profile.impactBias * lengthPenalty);
      const confidence = clamp01((chainConfidence * 0.65 + chainStrength * 0.35) * lengthPenalty);
      const riskScore = clamp01((impact * 0.65 + confidence * 0.35) * profile.riskBias);
      const severity = severityFromScore(riskScore, profile);
      const chainEvidence = collectEvidence(chain);
      const terminalNodeId = terminalEdge.to || '';

      totalConfidence += confidence;
      confidenceCount += 1;

      outcomes.push({
        chain,
        relation: terminalEdge.relation,
        effect: profile.effect,
        impact,
        confidence,
        severity,
        evidence: chainEvidence,
        description: this._describeChain(chain),
      });

      if (severity !== 'unknown') {
        risks.push({
          chain: chain.map(step => step.to || ''),
          relation: terminalEdge.relation,
          severity,
          impact,
          confidence,
          description: `${terminalEdge.relation}: ${terminalEdge.from} → ${terminalEdge.to} (impact: ${impact.toFixed(3)}, confidence: ${confidence.toFixed(3)})`,
        });
      }

      affectedNodes.push({
        nodeId: terminalNodeId,
        label: this.graph._nodes[terminalNodeId]?.label || terminalNodeId,
        relation: terminalEdge.relation,
        effect: profile.effect,
        impact,
        confidence,
        severity,
        path: chain.map(step => step.to || ''),
      });

      evidence.push(...chainEvidence);

      if (chainEvidence.length === 0) {
        unknowns.push(`Missing evidence for ${this._describeChain(chain)}`);
      }
    }

    const dedupAffectedNodes = [];
    const affectedNodeIndex = new Map();
    for (const item of affectedNodes) {
      const existing = affectedNodeIndex.get(item.nodeId);
      if (!existing) {
        affectedNodeIndex.set(item.nodeId, item);
        dedupAffectedNodes.push(item);
        continue;
      }

      const currentRank = rankSeverity(item.severity);
      const existingRank = rankSeverity(existing.severity);
      if (
        currentRank > existingRank ||
        (currentRank === existingRank && item.impact > existing.impact) ||
        (currentRank === existingRank && item.impact === existing.impact && item.confidence > existing.confidence)
      ) {
        Object.assign(existing, item);
      }
    }

    const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0;
    const traversalMetadata = traversal && typeof traversal === 'object' ? traversal : null;
    const traversalLoops = Array.isArray(traversalMetadata?.loops) ? traversalMetadata.loops : [];
    const traversalStoppedReason = traversalMetadata?.stoppedReason || (causalChains.length === 0 ? 'insufficient-data' : 'exhausted');
    const traversalMaxDepth = Number.isFinite(traversalMetadata?.maxDepth) ? traversalMetadata.maxDepth : maxDepth;
    const traversalConfidence = Number.isFinite(traversalMetadata?.confidence) ? traversalMetadata.confidence : avgConfidence;
    const mode = causalChains.length === 0 ? 'insufficient-data' : 'causal-backed';

    if (causalChains.length === 0) {
      unknowns.push(`No causal chain found for ${nodeId}`);
    }

    if (traversalStoppedReason === 'maxDepth') {
      unknowns.push(`Traversal stopped at maxDepth ${traversalMaxDepth}`);
    }

    if (traversalLoops.length > 0) {
      for (const loop of traversalLoops) {
        unknowns.push(`Loop detected: ${loop.join(' -> ')}`);
      }
    }

    const uniqueEvidence = uniqueStrings(evidence);
    const recommendation = this._deriveRecommendation(risks, avgConfidence, mode);

    return {
      ok: true,
      mode,
      action: action || `Simulate change on ${nodeId}`,
      nodeId,
      changeType: changeType || 'unknown',
      input: {
        action: action || `Simulate change on ${nodeId}`,
        nodeId,
        changeType: changeType || 'unknown',
        newState: typeof newState === 'undefined' ? null : newState,
        maxDepth: traversalMaxDepth,
      },
      affectedNodes: dedupAffectedNodes,
      causalChains: causalChains.length,
      causalChainDetails: causalChains,
      outcomes,
      risks,
      evidence: uniqueEvidence,
      unknowns: uniqueStrings(unknowns),
      confidence: traversalConfidence,
      traversal: traversalMetadata,
      recommendation,
      summary: this._generateSummary({
        mode,
        outcomes,
        risks,
        confidence: traversalConfidence,
        unknowns,
        traversalStoppedReason,
      })
    };
  }

  /**
   * Describe a causal chain in natural language
   * @private
   */
  _describeChain(chain) {
    if (chain.length === 0) return 'No causal chain';

    const parts = chain.map(e => {
      const relation = describeRelation(e.relation);
      return `${e.from} ${relation} ${e.to}`;
    });

    return parts.join(' → ');
  }

  /**
   * Generate a summary of the simulation
   * @private
   */
  _generateSummary({ mode, outcomes, risks, confidence, unknowns, traversalStoppedReason }) {
    const riskCount = risks.length;
    const outcomeCount = outcomes.length;

    let summary = `${mode === 'causal-backed' ? 'Simulation found' : 'Simulation had'} ${outcomeCount} causal outcome(s)`;
    if (riskCount > 0) {
      summary += ` with ${riskCount} high-risk consequence(s)`;
    }
    summary += `. Overall confidence: ${(confidence * 100).toFixed(1)}%`;

    if (riskCount > 0) {
      const criticalRisks = risks.filter(r => r.severity === 'critical');
      if (criticalRisks.length > 0) {
        summary += `. CRITICAL: ${criticalRisks.length} critical risk(s) detected.`;
      }
    }

    if (mode !== 'causal-backed') {
      summary += `. Mode: ${mode}.`;
    }

    if (traversalStoppedReason === 'maxDepth') {
      summary += ` Traversal stopped at maxDepth.`;
    }

    if (unknowns && unknowns.length > 0) {
      summary += ` Unknowns: ${unknowns.length}.`;
    }

    return summary;
  }

  _deriveRecommendation(risks, confidence, mode) {
    if (mode === 'missing-node') {
      return 'Node not found; seed the graph before simulating.';
    }

    if (risks.length === 0) {
      if (confidence >= 0.75) {
        return 'Change looks safe with current evidence; proceed cautiously.';
      }
      return 'No direct risk detected, but confidence is low; gather more evidence.';
    }

    const criticalRisks = risks.filter(r => r.severity === 'critical');
    if (criticalRisks.length > 0) {
      return `CRITICAL: ${criticalRisks.length} critical risk(s) detected. Change is not recommended.`;
    }

    const highRisks = risks.filter(r => r.severity === 'high');
    if (highRisks.length > 0) {
      return `HIGH RISK: ${highRisks.length} high risk(s) detected. Review alternatives before proceeding.`;
    }

    const mediumRisks = risks.filter(r => r.severity === 'medium');
    if (mediumRisks.length > 0) {
      return `${mediumRisks.length} medium risk(s) detected. Evaluate the trade-off before proceeding.`;
    }

    return `${risks.length} risk(s) detected. Review before acting.`;
  }

  /**
   * Get all causal relations in the graph
   */
  getCausalRelations() {
    return this.graph.getCausalRelations();
  }

  /**
   * Check if a relation is causal
   */
  isCausalRelation(relation) {
    return this.graph.isCausalRelation(relation);
  }
}

module.exports = { CausalSimulator };
