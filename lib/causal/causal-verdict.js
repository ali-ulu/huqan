'use strict';

const { TRAVERSAL_RELATION_PRIORITY } = require('./causal-traversal');

const CAUSAL_VERDICT_STATUSES = Object.freeze([
  'supports',
  'contradicts',
  'inconclusive',
  'cycle_blocked',
  'depth_incomplete',
]);

const CAUSAL_VERDICT_VERSION = '1.0.0';

const SUPPORT_RELATION_TYPES = Object.freeze(['CAUSES', 'ENABLES', 'LEADS_TO', 'DEPENDS_ON']);

// Scoring weights for scoreCausalVerdict. Centralized so they can be tuned
// without touching the scoring logic and so the names document intent.
const CAUSAL_SCORE_WEIGHTS = Object.freeze({
  BASE_CONFIDENCE: 0.33,
  EVIDENCE_MULTIPLIER: 0.35,
  MAX_SUPPORT_COVERAGE_BONUS: 0.25,
  SUPPORT_COVERAGE_DIVISOR: 5,
  MAX_PREVENT_PENALTY: 0.18,
  PREVENT_PENALTY_PER_EDGE: 0.06,
  MAX_WARNING_PENALTY: 0.18,
  WARNING_PENALTY_PER_WARNING: 0.03,
  MAX_BRANCH_PENALTY: 0.2,
  BRANCH_PENALTY_PER_BRANCH: 0.05,
  DEFAULT_EDGE_CONFIDENCE: 0.5,
  STATUS_BONUS_SUPPORTS: 0.12,
  STATUS_BONUS_CONTRADICTS: 0.22,
  STATUS_PENALTY_DEPTH_INCOMPLETE: -0.08,
  STATUS_PENALTY_CYCLE_BLOCKED: -0.24,
  STATUS_PENALTY_INCONCLUSIVE: -0.12,
  FALLBACK_CONFIDENCE: 0.33,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value, fallback = 0) {
  if (!isFiniteNumber(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function uniquePush(set, list, value) {
  if (value === undefined || value === null) return;
  const text = typeof value === 'string' ? value : String(value);
  if (text.length === 0 || set.has(text)) return;
  set.add(text);
  list.push(text);
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeEdgeLike(edge, fallbackIndex = 0) {
  if (!isObject(edge)) {
    return {
      edgeId: null,
      from: null,
      to: null,
      relation: null,
      strength: null,
      confidence: null,
      depth: null,
      pathIndex: fallbackIndex,
    };
  }

  const edgeId = typeof edge.edgeId === 'string' && edge.edgeId.length > 0
    ? edge.edgeId
    : typeof edge.id === 'string' && edge.id.length > 0
      ? edge.id
      : null;

  return {
    edgeId,
    from: typeof edge.from === 'string' ? edge.from : (edge.from == null ? null : String(edge.from)),
    to: typeof edge.to === 'string' ? edge.to : (edge.to == null ? null : String(edge.to)),
    relation: typeof edge.relation === 'string' ? edge.relation : (edge.relation == null ? null : String(edge.relation)),
    strength: isFiniteNumber(edge.strength) ? clamp01(edge.strength) : null,
    confidence: isFiniteNumber(edge.confidence) ? clamp01(edge.confidence) : null,
    depth: isFiniteNumber(edge.depth) ? edge.depth : null,
    pathIndex: isFiniteNumber(edge.pathIndex) ? edge.pathIndex : fallbackIndex,
  };
}

function normalizeBlockedBranch(branch, fallbackIndex = 0) {
  if (!isObject(branch)) {
    return {
      reason: 'unknown',
      edgeId: null,
      from: null,
      to: null,
      relation: null,
      depth: null,
      nextDepth: null,
      pathNodeIds: [],
      pathEdgeIds: [],
      pathIndex: fallbackIndex,
    };
  }

  const normalized = {
    reason: typeof branch.reason === 'string' && branch.reason.length > 0 ? branch.reason : 'unknown',
    edgeId: typeof branch.edgeId === 'string' && branch.edgeId.length > 0 ? branch.edgeId : null,
    from: typeof branch.from === 'string' && branch.from.length > 0 ? branch.from : (branch.from == null ? null : String(branch.from)),
    to: typeof branch.to === 'string' && branch.to.length > 0 ? branch.to : (branch.to == null ? null : String(branch.to)),
    relation: typeof branch.relation === 'string' && branch.relation.length > 0 ? branch.relation : (branch.relation == null ? null : String(branch.relation)),
    depth: isFiniteNumber(branch.depth) ? branch.depth : null,
    nextDepth: isFiniteNumber(branch.nextDepth) ? branch.nextDepth : null,
    pathNodeIds: Array.isArray(branch.pathNodeIds) ? branch.pathNodeIds.filter(item => typeof item === 'string') : [],
    pathEdgeIds: Array.isArray(branch.pathEdgeIds) ? branch.pathEdgeIds.filter(item => typeof item === 'string') : [],
    pathIndex: isFiniteNumber(branch.pathIndex) ? branch.pathIndex : fallbackIndex,
  };

  if (branch.maxEdges !== undefined) normalized.maxEdges = isFiniteNumber(branch.maxEdges) ? branch.maxEdges : null;
  if (branch.maxDepth !== undefined) normalized.maxDepth = isFiniteNumber(branch.maxDepth) ? branch.maxDepth : null;
  if (branch.visitedEdgeCount !== undefined) normalized.visitedEdgeCount = isFiniteNumber(branch.visitedEdgeCount) ? branch.visitedEdgeCount : null;
  if (branch.cycleNodeId !== undefined) normalized.cycleNodeId = branch.cycleNodeId == null ? null : String(branch.cycleNodeId);

  return normalized;
}

function normalizeTraversal(input) {
  const traversal = isObject(input?.traversal) ? input.traversal : (isObject(input) ? input : {});
  const traversalOrder = Array.isArray(traversal.traversalOrder)
    ? traversal.traversalOrder.map((entry, index) => normalizeEdgeLike(entry, index))
    : [];
  const blockedBranches = Array.isArray(traversal.blockedBranches)
    ? traversal.blockedBranches.map((branch, index) => normalizeBlockedBranch(branch, index))
    : [];
  const warnings = Array.isArray(traversal.warnings)
    ? traversal.warnings.filter(isObject).map((warning, index) => ({
      code: typeof warning.code === 'string' ? warning.code : 'UNKNOWN_WARNING',
      message: typeof warning.message === 'string' ? warning.message : '',
      field: typeof warning.field === 'string' ? warning.field : null,
      pathIndex: isFiniteNumber(warning.pathIndex) ? warning.pathIndex : index,
      nodeId: warning.nodeId == null ? null : String(warning.nodeId),
      depth: isFiniteNumber(warning.depth) ? warning.depth : null,
    }))
    : [];

  const stopReason = typeof traversal.stopReason === 'string' && traversal.stopReason.length > 0
    ? traversal.stopReason
    : 'terminus';
  const stopReasons = Array.isArray(traversal.stopReasons) && traversal.stopReasons.length > 0
    ? normalizeStringList(traversal.stopReasons)
    : [stopReason];

  return {
    startId: traversal.startId == null ? null : String(traversal.startId),
    workspaceId: traversal.workspaceId == null ? null : String(traversal.workspaceId),
    completed: traversal.completed !== false,
    stopReason,
    stopReasons,
    visitedEdgeCount: isFiniteNumber(traversal.visitedEdgeCount) ? traversal.visitedEdgeCount : traversalOrder.length,
    visitedNodeCount: isFiniteNumber(traversal.visitedNodeCount)
      ? traversal.visitedNodeCount
      : Math.max(1, new Set([
        traversal.startId == null ? null : String(traversal.startId),
        ...traversalOrder.map(entry => entry.to).filter(Boolean),
      ]).size),
    maxDepthReached: isFiniteNumber(traversal.maxDepthReached) ? traversal.maxDepthReached : 0,
    traversalOrder,
    blockedBranches,
    cycleNodeIds: Array.isArray(traversal.cycleNodeIds) ? traversal.cycleNodeIds.filter(item => typeof item === 'string') : [],
    cycleEdgeIds: Array.isArray(traversal.cycleEdgeIds) ? traversal.cycleEdgeIds.filter(item => typeof item === 'string') : [],
    warnings,
    relationPriority: isObject(traversal.relationPriority) ? traversal.relationPriority : TRAVERSAL_RELATION_PRIORITY,
  };
}

function normalizeContradictionSignal(input) {
  if (!input) return null;
  if (input === true) {
    return {
      present: true,
      reason: 'explicit_contradiction',
      confidence: 0.9,
      edges: [],
    };
  }

  if (typeof input === 'string') {
    return {
      present: true,
      reason: input,
      confidence: 0.9,
      edges: [],
    };
  }

  if (!isObject(input)) return null;

  const edges = [];
  if (Array.isArray(input.edges)) {
    for (let i = 0; i < input.edges.length; i++) {
      edges.push(normalizeEdgeLike(input.edges[i], i));
    }
  } else if (input.edge) {
    edges.push(normalizeEdgeLike(input.edge, 0));
  }

  return {
    present: true,
    reason: typeof input.reason === 'string' && input.reason.length > 0 ? input.reason : 'explicit_contradiction',
    confidence: isFiniteNumber(input.confidence) ? clamp01(input.confidence, 0.9) : 0.9,
    edges,
  };
}

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

  const supportingEdges = traversal.traversalOrder.map(edge => ({ ...edge }));
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

  if (traversal.traversalOrder.some(edge => edge.relation === 'PREVENTS')) {
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
    contradictingEdges: contradictoryEdges,
    blockedBranches: traversal.blockedBranches.map((branch, index) => ({ ...branch, pathIndex: branch.pathIndex ?? index })),
    visitedEdgeCount: traversal.visitedEdgeCount,
    visitedNodeCount: traversal.visitedNodeCount,
    maxDepthReached: traversal.maxDepthReached,
    warnings,
    riskFlags,
  };
}

function resolveVerdictStatus(traversal, trace, contradictionSignal) {
  if (contradictionSignal) return 'contradicts';

  switch (traversal.stopReason) {
    case 'cycle_detected':
      return 'cycle_blocked';
    case 'depth_exceeded':
    case 'max_edges_exceeded':
      return 'depth_incomplete';
    case 'missing_start':
      return 'inconclusive';
    case 'terminus':
      return trace.supportingEdges.length > 0 ? 'supports' : 'inconclusive';
    default:
      return traversal.traversalOrder.length > 0 ? 'supports' : 'inconclusive';
  }
}

function scoreCausalVerdict(status, trace) {
  const W = CAUSAL_SCORE_WEIGHTS;
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
  const preventPenalty = trace.supportingEdges.some(edge => edge.relation === 'PREVENTS')
    ? Math.min(W.MAX_PREVENT_PENALTY, trace.supportingEdges.filter(edge => edge.relation === 'PREVENTS').length * W.PREVENT_PENALTY_PER_EDGE)
    : 0;
  const warningPenalty = Math.min(W.MAX_WARNING_PENALTY, trace.warnings.length * W.WARNING_PENALTY_PER_WARNING);
  const branchPenalty = Math.min(W.MAX_BRANCH_PENALTY, trace.blockedBranches.length * W.BRANCH_PENALTY_PER_BRANCH);

  let confidence = W.BASE_CONFIDENCE;
  confidence += averageEvidence * W.EVIDENCE_MULTIPLIER;
  confidence += supportCoverage;

  if (status === 'supports') {
    confidence += W.STATUS_BONUS_SUPPORTS;
  } else if (status === 'contradicts') {
    confidence += W.STATUS_BONUS_CONTRADICTS;
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

function buildCausalVerdict(traversalResult, options = {}) {
  const traversal = normalizeTraversal(traversalResult);
  const trace = buildCausalTrace(traversalResult, options);
  const contradictionSignal = normalizeContradictionSignal(
    options.contradictionSignal
      ?? traversalResult?.meta?.contradictionSignal
      ?? traversalResult?.traversal?.contradictionSignal
      ?? traversalResult?.traversal?.explicitContradiction
      ?? traversalResult?.explicitContradiction,
  );

  const status = resolveVerdictStatus(traversal, trace, contradictionSignal);
  const confidence = scoreCausalVerdict(status, trace);
  const reasons = [];
  const warnings = [...trace.warnings];
  const riskFlags = [...trace.riskFlags];

  uniquePush(new Set(reasons), reasons, status === 'supports'
    ? 'CAUSAL_PATH_FOUND'
    : status === 'contradicts'
      ? 'EXPLICIT_CONTRADICTION_SIGNAL'
      : status === 'cycle_blocked'
        ? 'CYCLE_DETECTED'
        : status === 'depth_incomplete'
          ? 'PARTIAL_TRAVERSAL'
          : 'INCONCLUSIVE_TRAVERSAL');

  if (traversal.stopReason === 'terminus' && trace.supportingEdges.length === 0) {
    uniquePush(new Set(reasons), reasons, 'EMPTY_TRAVERSAL');
  }

  if (traversal.stopReason === 'missing_start') {
    uniquePush(new Set(reasons), reasons, 'MISSING_START');
  }

  if (traversal.stopReason === 'depth_exceeded' || traversal.stopReason === 'max_edges_exceeded') {
    uniquePush(new Set(reasons), reasons, 'PARTIAL_TRAVERSAL');
  }

  if (traversal.stopReason === 'cycle_detected') {
    uniquePush(new Set(reasons), reasons, 'CYCLE_DETECTED');
  }

  if (traversal.traversalOrder.some(edge => edge.relation === 'PREVENTS')) {
    uniquePush(new Set(warnings), warnings, 'PREVENTS_SIGNAL');
    uniquePush(new Set(riskFlags), riskFlags, 'prevents_signal');
  }

  if (contradictionSignal) {
    uniquePush(new Set(warnings), warnings, 'EXPLICIT_CONTRADICTION_SIGNAL');
    uniquePush(new Set(riskFlags), riskFlags, 'explicit_contradiction_signal');
  }

  return normalizeCausalVerdict({
    ok: true,
    verdict: {
      status,
      confidence,
      reasons,
      warnings,
      riskFlags,
      trace,
    },
    meta: {
      source: 'causal-traversal',
      version: CAUSAL_VERDICT_VERSION,
    },
  });
}

module.exports = {
  CAUSAL_VERDICT_STATUSES,
  CAUSAL_VERDICT_VERSION,
  SUPPORT_RELATION_TYPES,
  CAUSAL_SCORE_WEIGHTS,
  buildCausalTrace,
  scoreCausalVerdict,
  normalizeCausalVerdict,
  buildCausalVerdict,
};
