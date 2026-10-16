'use strict';

// Verdict scoring and verdict-object normalization for the causal verdict.
// Split out of lib/causal/causal-verdict.js (#2175): the status/confidence
// scorer and the persisted-verdict shape normalizer moved here byte-identical;
// trace construction lives in its own module.

const {
  CAUSAL_VERDICT_STATUSES,
  CAUSAL_VERDICT_VERSION,
  CAUSAL_SCORE_WEIGHTS,
} = require('./causal-verdict-weights');
const {
  isObject,
  isFiniteNumber,
  clamp01,
  normalizeStringList,
  normalizeEdgeLike,
  normalizeBlockedBranch,
  normalizeContradictionSignal,
} = require('./causal-verdict-normalize');

function scoreCausalVerdict(status, trace, contradictionSignal) {
  const W = CAUSAL_SCORE_WEIGHTS;
  const normalizedContradictionSignal = normalizeContradictionSignal(contradictionSignal);
  const contradictionConfidence = normalizedContradictionSignal?.confidence ?? 1;
  const evidenceEdges = trace.supportingEdges.filter(edge => edge.relation !== 'PREVENTS');
  const evidenceScores = evidenceEdges
    .map(edge => {
      const primary = isFiniteNumber(edge.confidence) ? edge.confidence : null;
      const secondary = isFiniteNumber(edge.strength) ? edge.strength : null;
      return primary ?? secondary ?? W.DEFAULT_EDGE_CONFIDENCE;
    });
  const averageEvidence = evidenceScores.length > 0
    ? evidenceScores.reduce((acc, value) => acc + value, 0) / evidenceScores.length
    : 0;

  const supportCoverage = trace.supportingEdges.length > 0
    ? Math.min(trace.supportingEdges.length / W.SUPPORT_COVERAGE_DIVISOR, W.MAX_SUPPORT_COVERAGE_BONUS)
    : 0;
  const preventPenalty = trace.preventingEdges
    ? Math.min(W.MAX_PREVENT_PENALTY, trace.preventingEdges.length * W.PREVENT_PENALTY_PER_EDGE)
    : 0;
  const warningPenalty = Math.min(W.MAX_WARNING_PENALTY, trace.warnings.length * W.WARNING_PENALTY_PER_WARNING);
  const branchPenalty = Math.min(W.MAX_BRANCH_PENALTY, trace.blockedBranches.length * W.BRANCH_PENALTY_PER_BRANCH);

  let confidence = W.BASE_CONFIDENCE;
  confidence += averageEvidence * W.EVIDENCE_MULTIPLIER;
  confidence += supportCoverage;

  if (status === 'supports') {
    confidence += W.STATUS_BONUS_SUPPORTS;
  } else if (status === 'contradicts') {
    confidence += W.STATUS_BONUS_CONTRADICTS * contradictionConfidence;
  } else if (status === 'depth_incomplete') {
    confidence += W.STATUS_PENALTY_DEPTH_INCOMPLETE;
  } else if (status === 'cycle_blocked') {
    confidence += W.STATUS_PENALTY_CYCLE_BLOCKED;
  } else if (status === 'inconclusive') {
    confidence += W.STATUS_PENALTY_INCONCLUSIVE;
  }

  confidence -= warningPenalty;
  confidence -= branchPenalty;
  confidence -= preventPenalty;

  return clamp01(confidence, W.FALLBACK_CONFIDENCE);
}

function normalizeCausalVerdict(value) {
  if (!isObject(value)) return null;
  const verdict = isObject(value.verdict) ? value.verdict : {};
  const status = CAUSAL_VERDICT_STATUSES.includes(verdict.status) ? verdict.status : 'inconclusive';
  const trace = isObject(verdict.trace) ? verdict.trace : {};

  return {
    ok: value.ok !== false,
    verdict: {
      status,
      confidence: clamp01(verdict.confidence, 0),
      reasons: normalizeStringList(verdict.reasons),
      warnings: normalizeStringList(verdict.warnings),
      riskFlags: normalizeStringList(verdict.riskFlags),
      trace: {
        startId: trace.startId == null ? null : String(trace.startId),
        workspaceId: trace.workspaceId == null ? null : String(trace.workspaceId),
        stopReason: typeof trace.stopReason === 'string' ? trace.stopReason : 'terminus',
        stopReasons: normalizeStringList(trace.stopReasons),
        traversalSummary: isObject(trace.traversalSummary) ? { ...trace.traversalSummary } : {},
        supportingEdges: Array.isArray(trace.supportingEdges) ? trace.supportingEdges.map((edge, index) => normalizeEdgeLike(edge, index)) : [],
        preventingEdges: Array.isArray(trace.preventingEdges) ? trace.preventingEdges.map((edge, index) => normalizeEdgeLike(edge, index)) : [],
        contradictingEdges: Array.isArray(trace.contradictingEdges) ? trace.contradictingEdges.map((edge, index) => normalizeEdgeLike(edge, index)) : [],
        blockedBranches: Array.isArray(trace.blockedBranches) ? trace.blockedBranches.map((branch, index) => normalizeBlockedBranch(branch, index)) : [],
        visitedEdgeCount: isFiniteNumber(trace.visitedEdgeCount) ? trace.visitedEdgeCount : 0,
        visitedNodeCount: isFiniteNumber(trace.visitedNodeCount) ? trace.visitedNodeCount : 0,
        maxDepthReached: isFiniteNumber(trace.maxDepthReached) ? trace.maxDepthReached : 0,
      },
    },
    meta: {
      source: typeof value.meta?.source === 'string' ? value.meta.source : 'causal-traversal',
      version: typeof value.meta?.version === 'string' ? value.meta.version : CAUSAL_VERDICT_VERSION,
    },
  };
}

module.exports = {
  scoreCausalVerdict,
  normalizeCausalVerdict,
};
