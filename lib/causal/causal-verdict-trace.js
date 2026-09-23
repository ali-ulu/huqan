'use strict';

// Verdict-trace construction for the causal verdict: turn a traversal result
// into the supporting/preventing/contradicting edge lists, warnings and risk
// flags that the verdict status and confidence are derived from. Split out of
// lib/causal/causal-verdict.js (#2175); the code is moved, not rewritten.

const { SUPPORT_RELATION_TYPES } = require('./causal-verdict-weights');
const {
  isFiniteNumber,
  uniquePush,
  normalizeTraversal,
  normalizeContradictionSignal,
} = require('./causal-verdict-normalize');

function collectRelationSummary(traversalOrder) {
  const summary = {
    totalEdges: traversalOrder.length,
    supportEdges: 0,
    preventsEdges: 0,
    minStrength: null,
    maxStrength: null,
    averageStrength: 0,
    averageConfidence: 0,
  };

  const strengthValues = [];
  const confidenceValues = [];

  for (const edge of traversalOrder) {
    if (edge.relation === 'PREVENTS') {
      summary.preventsEdges += 1;
    } else if (SUPPORT_RELATION_TYPES.includes(edge.relation)) {
      summary.supportEdges += 1;
    }

    if (isFiniteNumber(edge.strength)) {
      strengthValues.push(edge.strength);
      summary.minStrength = summary.minStrength === null ? edge.strength : Math.min(summary.minStrength, edge.strength);
      summary.maxStrength = summary.maxStrength === null ? edge.strength : Math.max(summary.maxStrength, edge.strength);
    }

    if (isFiniteNumber(edge.confidence)) {
      confidenceValues.push(edge.confidence);
    }
  }

  if (strengthValues.length > 0) {
    summary.averageStrength = strengthValues.reduce((acc, value) => acc + value, 0) / strengthValues.length;
  }
  if (confidenceValues.length > 0) {
    summary.averageConfidence = confidenceValues.reduce((acc, value) => acc + value, 0) / confidenceValues.length;
  }

  return summary;
}

function buildCausalTrace(traversalResult, options = {}) {
  const traversal = normalizeTraversal(traversalResult);
  const contradictionSignal = normalizeContradictionSignal(
    options.contradictionSignal
      ?? traversalResult?.meta?.contradictionSignal
      ?? traversalResult?.traversal?.contradictionSignal
      ?? traversalResult?.traversal?.explicitContradiction
      ?? traversalResult?.explicitContradiction,
  );

  const supportingEdges = traversal.traversalOrder
    .filter(edge => SUPPORT_RELATION_TYPES.includes(edge.relation))
    .map(edge => ({ ...edge }));
  const preventingEdges = traversal.traversalOrder
    .filter(edge => edge.relation === 'PREVENTS')
    .map(edge => ({ ...edge }));
  const contradictoryEdges = contradictionSignal && contradictionSignal.edges.length > 0
    ? contradictionSignal.edges.map(edge => ({ ...edge }))
    : [];

  const warningSet = new Set();
  const warnings = [];
  const riskFlagSet = new Set();
  const riskFlags = [];

  for (const warning of traversal.warnings) {
    uniquePush(warningSet, warnings, warning.code);
  }

  if (traversal.stopReason === 'depth_exceeded' || traversal.stopReason === 'max_edges_exceeded') {
    uniquePush(warningSet, warnings, 'PARTIAL_TRAVERSAL');
  }

  if (traversal.stopReason === 'cycle_detected') {
    uniquePush(warningSet, warnings, 'CYCLE_DETECTED');
    uniquePush(riskFlagSet, riskFlags, 'circular_reasoning_risk');
  }

  if (preventingEdges.length > 0) {
    uniquePush(warningSet, warnings, 'PREVENTS_SIGNAL');
    uniquePush(riskFlagSet, riskFlags, 'prevents_signal');
  }

  if (contradictionSignal) {
    uniquePush(warningSet, warnings, 'EXPLICIT_CONTRADICTION_SIGNAL');
    uniquePush(riskFlagSet, riskFlags, 'explicit_contradiction_signal');
    if (contradictoryEdges.length === 0) {
      contradictoryEdges.push({
        edgeId: null,
        from: null,
        to: null,
        relation: null,
        strength: null,
        confidence: contradictionSignal.confidence,
        reason: contradictionSignal.reason,
      });
    }
  }

  const traversalSummary = collectRelationSummary(traversal.traversalOrder);
  return {
    startId: traversal.startId,
    workspaceId: traversal.workspaceId,
    stopReason: traversal.stopReason,
    stopReasons: traversal.stopReasons,
    traversalSummary: {
      ...traversalSummary,
      completed: traversal.completed,
      stopReason: traversal.stopReason,
      stopReasons: [...traversal.stopReasons],
      visitedEdgeCount: traversal.visitedEdgeCount,
      visitedNodeCount: traversal.visitedNodeCount,
      maxDepthReached: traversal.maxDepthReached,
      blockedBranchCount: traversal.blockedBranches.length,
      warningCount: warnings.length,
      riskFlagCount: riskFlags.length,
      contradictionPresent: Boolean(contradictionSignal),
    },
    supportingEdges,
    preventingEdges,
    contradictingEdges: contradictoryEdges,
    blockedBranches: traversal.blockedBranches.map((branch, index) => ({ ...branch, pathIndex: branch.pathIndex ?? index })),
    visitedEdgeCount: traversal.visitedEdgeCount,
    visitedNodeCount: traversal.visitedNodeCount,
    maxDepthReached: traversal.maxDepthReached,
    warnings,
    riskFlags,
  };
}

module.exports = {
  collectRelationSummary,
  buildCausalTrace,
};
