'use strict';

// Bounded, deterministic causal graph traversal. Edge ordering lives in
// causal-traversal-edges.js, graph lookups and records in
// causal-traversal-resolvers.js (#2194).

const { TRAVERSAL_RELATION_PRIORITY, TRAVERSAL_STOP_REASON_ORDER, canonicalEdgeView, clonePath, compareTraversalEdges, normalizeLimit, pickStopReason, pushUnique, stableStringify } = require('./causal-traversal-edges');
const { getNodeResolver, getOutgoingEdgeResolver, makeBlockedBranch, normalizeTraversalEntry } = require('./causal-traversal-resolvers');

function traverseCausalGraph(graph, startId, options = {}) {
  const maxDepth = normalizeLimit(options.maxDepth, Number.POSITIVE_INFINITY);
  const maxEdges = normalizeLimit(options.maxEdges, Number.POSITIVE_INFINITY);
  // Resolved before the resolvers are built: they need it (#397).
  const workspaceId = typeof options.workspaceId === 'string' && options.workspaceId.trim().length > 0
    ? options.workspaceId.trim()
    : null;
  const resolveNode = getNodeResolver(graph, workspaceId);
  const resolveEdges = getOutgoingEdgeResolver(graph, workspaceId);

  const startNode = resolveNode(startId);
  if (startNode === null || startNode === undefined) {
    return {
      ok: true,
      traversal: {
        startId,
        workspaceId,
        completed: false,
        stopReason: 'missing_start',
        stopReasons: ['missing_start'],
        visitedEdgeCount: 0,
        visitedNodeCount: 0,
        maxDepthReached: 0,
        traversalOrder: [],
        cycleNodeIds: [],
        cycleEdgeIds: [],
        blockedBranches: [],
        warnings: [],
      },
      meta: {
        maxDepth,
        maxEdges,
      },
    };
  }

  const traversalOrder = [];
  const blockedBranches = [];
  const cycleNodeIds = [];
  const cycleEdgeIds = [];
  const stopReasons = new Set();
  const stopReasonList = [];
  const cycleNodeSet = new Set();
  const cycleEdgeSet = new Set();
  const finishedNodeSet = new Set();
  const warnings = [];

  let visitedEdgeCount = 0;
  let maxDepthReached = 0;
  let globalEdgeLimitReached = false;

  function recordStopReason(reason) {
    pushUnique(stopReasons, stopReasonList, reason);
  }

  function visit(startNodeId) {
    const pathNodeIds = [startNodeId];
    const pathNodeSet = new Set(pathNodeIds);
    const pathEdgeIds = [];
    const stack = [{
      nodeId: startNodeId,
      depth: 0,
      candidates: resolveEdges(startNodeId).map(canonicalEdgeView).sort(compareTraversalEdges),
      candidateIndex: 0,
      enteredNodeId: null,
    }];

    while (stack.length > 0 && !globalEdgeLimitReached) {
      const frame = stack[stack.length - 1];
      if (frame.candidateIndex >= frame.candidates.length) {
        stack.pop();
        finishedNodeSet.add(frame.nodeId);
        if (frame.enteredNodeId !== null) {
          pathNodeSet.delete(frame.enteredNodeId);
          pathNodeIds.pop();
          pathEdgeIds.pop();
        }
        continue;
      }

      const edge = frame.candidates[frame.candidateIndex];
      frame.candidateIndex += 1;
      const depth = frame.depth;

      if (visitedEdgeCount >= maxEdges) {
        recordStopReason('max_edges_exceeded');
        blockedBranches.push(makeBlockedBranch('max_edges_exceeded', edge, depth, depth + 1, pathNodeIds, pathEdgeIds, {
          maxEdges,
          visitedEdgeCount,
        }));
        globalEdgeLimitReached = true;
        return;
      }

      const nextNodeId = edge.to;
      const nextDepth = depth + 1;

      if (pathNodeSet.has(nextNodeId)) {
        recordStopReason('cycle_detected');
        pushUnique(cycleNodeSet, cycleNodeIds, nextNodeId);
        if (edge.edgeId) {
          pushUnique(cycleEdgeSet, cycleEdgeIds, edge.edgeId);
        }
        blockedBranches.push(makeBlockedBranch('cycle_detected', edge, depth, nextDepth, pathNodeIds, pathEdgeIds, {
          cycleNodeId: nextNodeId,
          cyclePathNodeIds: clonePath(pathNodeIds),
        }));
        continue;
      }

      if (nextDepth > maxDepth) {
        recordStopReason('depth_exceeded');
        blockedBranches.push(makeBlockedBranch('depth_exceeded', edge, depth, nextDepth, pathNodeIds, pathEdgeIds, {
          maxDepth,
        }));
        warnings.push({
          code: 'MAX_DEPTH_EXCEEDED',
          message: `maxDepth ${maxDepth} exceeded at edge ${edge.edgeId || `${edge.from}->${edge.to}`}`,
          nodeId: nextNodeId,
          depth: nextDepth,
        });
        continue;
      }

      visitedEdgeCount += 1;
      maxDepthReached = Math.max(maxDepthReached, nextDepth);
      traversalOrder.push(normalizeTraversalEntry(edge, nextDepth, traversalOrder.length));

      if (finishedNodeSet.has(nextNodeId)) continue;

      pathNodeIds.push(nextNodeId);
      pathNodeSet.add(nextNodeId);
      pathEdgeIds.push(edge.edgeId || null);
      stack.push({
        nodeId: nextNodeId,
        depth: nextDepth,
        candidates: resolveEdges(nextNodeId).map(canonicalEdgeView).sort(compareTraversalEdges),
        candidateIndex: 0,
        enteredNodeId: nextNodeId,
      });
    }
  }

  visit(startId);

  const stopReason = pickStopReason(stopReasons);
  const completed = stopReasons.size === 0;
  const uniqueStopReasons = stopReasonList.length > 0 ? stopReasonList : ['terminus'];

  return {
    ok: true,
    traversal: {
      startId,
      workspaceId,
      completed,
      stopReason,
      stopReasons: uniqueStopReasons,
      visitedEdgeCount,
      visitedNodeCount: traversalOrder.length > 0 ? new Set([startId, ...traversalOrder.map(item => item.to)]).size : 1,
      maxDepthReached,
      traversalOrder,
      cycleNodeIds,
      cycleEdgeIds,
      blockedBranches,
      warnings,
    },
    meta: {
      maxDepth,
      maxEdges,
      relationPriority: TRAVERSAL_RELATION_PRIORITY,
    },
  };
}

module.exports = {
  TRAVERSAL_RELATION_PRIORITY,
  TRAVERSAL_STOP_REASON_ORDER,
  stableStringify,
  canonicalEdgeView,
  compareTraversalEdges,
  traverseCausalGraph,
};
