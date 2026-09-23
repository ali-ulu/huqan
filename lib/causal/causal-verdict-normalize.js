'use strict';

// Shared normalization helpers and traversal-input shaping for the causal
// verdict. Split out of lib/causal/causal-verdict.js (#2175): edge/branch
// normalization, traversal normalization and contradiction-signal
// normalization moved here byte-identical; the verdict trace builder and
// scorer stay in their own modules.

const { TRAVERSAL_RELATION_PRIORITY } = require('./causal-traversal');

const { SUPPORT_RELATION_TYPES } = require('./causal-verdict-weights');

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

  const normalized = {
    edgeId,
    from: typeof edge.from === 'string' ? edge.from : (edge.from == null ? null : String(edge.from)),
    to: typeof edge.to === 'string' ? edge.to : (edge.to == null ? null : String(edge.to)),
    relation: typeof edge.relation === 'string' ? edge.relation : (edge.relation == null ? null : String(edge.relation)),
    strength: isFiniteNumber(edge.strength) ? clamp01(edge.strength) : null,
    confidence: isFiniteNumber(edge.confidence) ? clamp01(edge.confidence) : null,
    depth: isFiniteNumber(edge.depth) ? edge.depth : null,
    pathIndex: isFiniteNumber(edge.pathIndex) ? edge.pathIndex : fallbackIndex,
  };

  if (typeof edge.reason === 'string' && edge.reason.length > 0) {
    normalized.reason = edge.reason;
  }

  return normalized;
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

module.exports = {
  isObject,
  isFiniteNumber,
  clamp01,
  uniquePush,
  normalizeStringList,
  normalizeEdgeLike,
  normalizeBlockedBranch,
  normalizeTraversal,
  normalizeContradictionSignal,
};
