// CausalSimulator's per-chain scoring and the affected-node dedupe, moved out
// of causalSimulator.js (#2187). Pure: they read the traversal result and the
// scoped nodes and never touch the graph.

const { average, clamp01, collectEvidence, findScopedNode, normalizeStep, rankSeverity, relationProfile, severityFromScore } = require('./causal-simulator-scoring');
const { describeChain } = require('./causal-simulator-report');

function missingNodeResult({ action, nodeId, changeType, newState, maxDepth, workspaceId }) {
  return {
    ok: false,
    mode: 'missing-node',
    error: `Node '${nodeId}' not found in graph`,
    workspaceId,
    action: action || `Simulate change on ${nodeId}`,
    input: {
      action: action || `Simulate change on ${nodeId}`,
      nodeId,
      changeType: changeType || 'unknown',
      newState: typeof newState === 'undefined' ? null : newState,
      maxDepth,
      workspaceId,
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

function scoreChains(causalChains, scopedNodes, simulation) {
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
    const baseImpact = clamp01(chainStrength * profile.impactBias * lengthPenalty);
    const baseConfidence = clamp01((chainConfidence * 0.65 + chainStrength * 0.35) * lengthPenalty);
    const impact = clamp01(baseImpact * simulation.stateImpact);
    const confidence = clamp01(baseConfidence * simulation.stateImpact);
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
      simulationEffect: simulation.effect,
      evidence: chainEvidence,
      description: describeChain(chain),
    });

    if (severity !== 'unknown') {
      risks.push({
        chain: chain.map(step => step.to || ''),
        relation: terminalEdge.relation,
        severity,
        impact,
        confidence,
        simulationEffect: simulation.effect,
        description: `${terminalEdge.relation}: ${terminalEdge.from} → ${terminalEdge.to} (impact: ${impact.toFixed(3)}, confidence: ${confidence.toFixed(3)})`,
      });
    }

    affectedNodes.push({
      nodeId: terminalNodeId,
      label: findScopedNode(scopedNodes, terminalNodeId)?.label || terminalNodeId,
      relation: terminalEdge.relation,
      effect: profile.effect,
      impact,
      confidence,
      severity,
      path: chain.map(step => step.to || ''),
    });

    evidence.push(...chainEvidence);

    if (chainEvidence.length === 0) {
      unknowns.push(`Missing evidence for ${describeChain(chain)}`);
    }
  }

  return { outcomes, risks, affectedNodes, evidence, unknowns, totalConfidence, confidenceCount };
}

function dedupeAffectedNodes(affectedNodes) {
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
  return dedupAffectedNodes;
}

module.exports = { dedupeAffectedNodes, missingNodeResult, scoreChains };
