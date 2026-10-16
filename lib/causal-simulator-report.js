// CausalSimulator's prose: the chain description, the summary line and the
// recommendation, moved out of causalSimulator.js (#2187).

const { describeRelation } = require('./causal-simulator-scoring');

/**
 * Describe a causal chain in natural language
 * @private
 */
function describeChain(chain) {
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
function generateSummary({ mode, outcomes, risks, confidence, unknowns, traversalStoppedReason, simulation = null }) {
  const riskCount = risks.length;
  const outcomeCount = outcomes.length;
  const effect = simulation?.effect && simulation.effect !== 'observed' ? ` (${simulation.effect})` : '';

  let summary = `${mode === 'causal-backed' ? 'Simulation found' : 'Simulation had'} ${outcomeCount} causal outcome(s)${effect}`;
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

function deriveRecommendation(risks, confidence, mode, simulation = null) {
  if (mode === 'missing-node') {
    return 'Node not found; seed the graph before simulating.';
  }

  if (simulation?.stateImpact === 0) {
    return 'Hypothetical removal or disabled state suppresses downstream causal consequences; no active risk is projected.';
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

module.exports = { describeChain, deriveRecommendation, generateSummary };
