'use strict';

const { CAUSAL_EDGE_RELATIONS } = require('./causal-edge');

const TRAVERSAL_RELATION_PRIORITY = Object.freeze({
  CAUSES: 0,
  ENABLES: 1,
  LEADS_TO: 2,
  DEPENDS_ON: 3,
  PREVENTS: 4,
});

const TRAVERSAL_STOP_REASON_ORDER = Object.freeze([
  'cycle_detected',
  'max_edges_exceeded',
  'depth_exceeded',
  'missing_start',
  'terminus',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLimit(value, fallback = Number.POSITIVE_INFINITY) {
  if (value === undefined || value === null) return fallback;
  if (value === Number.POSITIVE_INFINITY) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  return Math.floor(value);
}

function getEdgeId(edge) {
  if (!isObject(edge)) return '';
  const edgeId = edge.edgeId ?? edge.id ?? edge.edge_id ?? edge.key ?? '';
  return typeof edgeId === 'string' && edgeId.trim().length > 0 ? edgeId : String(edgeId || '');
}

function getEdgeFrom(edge) {
  if (!isObject(edge)) return '';
  const from = edge.from ?? edge.fromId ?? edge.from_id ?? edge.source ?? '';
  return typeof from === 'string' && from.length > 0 ? from : String(from || '');
}

function getEdgeTo(edge) {
  if (!isObject(edge)) return '';
  const to = edge.to ?? edge.toId ?? edge.to_id ?? edge.target ?? '';
  return typeof to === 'string' && to.length > 0 ? to : String(to || '');
}

function getEdgeRelation(edge) {
  if (!isObject(edge)) return '';
  const relation = edge.relation ?? edge.type ?? '';
  return typeof relation === 'string' ? relation : String(relation || '');
}

function getEdgeStrength(edge) {
  if (!isObject(edge)) return null;
  const strength = edge.strength ?? edge.weight ?? null;
  return typeof strength === 'number' && Number.isFinite(strength) ? strength : null;
}

function stableStringify(value) {
  const seen = new WeakSet();

  function stringify(input) {
    if (input === null) return 'null';
    const inputType = typeof input;
    if (inputType === 'number') return Number.isFinite(input) ? String(input) : 'null';
    if (inputType === 'boolean') return input ? 'true' : 'false';
    if (inputType === 'string') return JSON.stringify(input);
    if (inputType === 'bigint') return JSON.stringify(String(input));
    if (inputType === 'undefined' || inputType === 'function' || inputType === 'symbol') {
      return 'null';
    }

    if (Array.isArray(input)) {
      return `[${input.map(item => stringify(item)).join(',')}]`;
    }

    if (!isObject(input)) {
      return JSON.stringify(String(input));
    }

    if (seen.has(input)) return '"[Circular]"';
    seen.add(input);
    const keys = Object.keys(input).sort();
    const entries = [];
    for (const key of keys) {
      const valueString = stringify(input[key]);
      if (valueString === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${valueString}`);
    }
    seen.delete(input);
    return `{${entries.join(',')}}`;
  }

  return stringify(value);
}

function canonicalEdgeView(edge) {
  return {
    edgeId: getEdgeId(edge),
    from: getEdgeFrom(edge),
    to: getEdgeTo(edge),
    relation: getEdgeRelation(edge),
    strength: getEdgeStrength(edge),
    raw: edge,
  };
}

function compareTraversalEdges(a, b) {
  const relationPriorityA = TRAVERSAL_RELATION_PRIORITY[a.relation] ?? Number.MAX_SAFE_INTEGER;
  const relationPriorityB = TRAVERSAL_RELATION_PRIORITY[b.relation] ?? Number.MAX_SAFE_INTEGER;
  if (relationPriorityA !== relationPriorityB) {
    return relationPriorityA - relationPriorityB;
  }

  const edgeIdA = a.edgeId || '';
  const edgeIdB = b.edgeId || '';
  if (edgeIdA !== edgeIdB) {
    return edgeIdA < edgeIdB ? -1 : 1;
  }

  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1;

  const stableA = stableStringify(a.raw);
  const stableB = stableStringify(b.raw);
  if (stableA !== stableB) return stableA < stableB ? -1 : 1;
  return 0;
}

function pickStopReason(stopReasons) {
  for (const reason of TRAVERSAL_STOP_REASON_ORDER) {
    if (stopReasons.has(reason)) return reason;
  }
  return 'terminus';
}

function pushUnique(targetSet, targetList, value) {
  if (!targetSet.has(value)) {
    targetSet.add(value);
    targetList.push(value);
  }
}

function clonePath(path) {
  return path.slice();
}

/**
 * Builds the node lookup used by the traversal.
 *
 * `workspaceId` has to be threaded through here: Graph's own reads take it as
 * a second argument defaulting to 'default', so resolving without it silently
 * read the default workspace while the traversal still reported the caller's
 * workspaceId in its result (#397).
 *
 * It is only forwarded when the caller actually supplied one. Passing an
 * explicit null would be normalized back to 'default' by Graph, but not
 * necessarily by other graph-like objects this module accepts, so omitting the
 * argument keeps the previous behaviour exactly for workspace-less callers.
 */
function getNodeResolver(graph, workspaceId = null) {
  if (!graph || typeof graph !== 'object') {
    return () => null;
  }

  if (typeof graph.getNode === 'function') {
    return nodeId => (workspaceId === null ? graph.getNode(nodeId) : graph.getNode(nodeId, workspaceId));
  }

  if (typeof graph.hasNode === 'function') {
    return nodeId => {
      const present = workspaceId === null ? graph.hasNode(nodeId) : graph.hasNode(nodeId, workspaceId);
      return present ? { id: nodeId } : null;
    };
  }

  if (Array.isArray(graph.nodes)) {
    return nodeId => graph.nodes.find(node => node && node.id === nodeId) || null;
  }

  if (graph.nodes && typeof graph.nodes === 'object') {
    return nodeId => {
      if (Object.prototype.hasOwnProperty.call(graph.nodes, nodeId)) {
        const node = graph.nodes[nodeId];
        return node && typeof node === 'object' ? node : { id: nodeId };
      }
      return null;
    };
  }

  if (Array.isArray(graph.edges)) {
    return nodeId => {
      const hasParticipation = graph.edges.some(edge => getEdgeFrom(edge) === nodeId || getEdgeTo(edge) === nodeId);
      return hasParticipation ? { id: nodeId } : null;
    };
  }

  return () => null;
}

/** Same workspace threading as getNodeResolver -- see its comment (#397). */
function getOutgoingEdgeResolver(graph, workspaceId = null) {
  if (!graph || typeof graph !== 'object') {
    return () => [];
  }

  if (typeof graph.getCausalEdges === 'function') {
    return nodeId => (workspaceId === null
      ? graph.getCausalEdges(nodeId)
      : graph.getCausalEdges(nodeId, workspaceId)) || [];
  }

  if (typeof graph.getOutgoingEdges === 'function') {
    return nodeId => {
      const edges = (workspaceId === null
        ? graph.getOutgoingEdges(nodeId)
        : graph.getOutgoingEdges(nodeId, workspaceId)) || [];
      return edges.filter(edge => CAUSAL_EDGE_RELATIONS.includes(getEdgeRelation(edge)));
    };
  }

  if (typeof graph.getEdges === 'function') {
    return nodeId => {
      const edges = (workspaceId === null
        ? graph.getEdges(nodeId)
        : graph.getEdges(nodeId, workspaceId)) || [];
      return edges.filter(edge => CAUSAL_EDGE_RELATIONS.includes(getEdgeRelation(edge)));
    };
  }

  if (Array.isArray(graph.edges)) {
    return nodeId => graph.edges.filter(edge => getEdgeFrom(edge) === nodeId && CAUSAL_EDGE_RELATIONS.includes(getEdgeRelation(edge)));
  }

  return () => [];
}

function normalizeTraversalEntry(edge, depth, pathIndex) {
  return {
    edgeId: edge.edgeId || null,
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    strength: edge.strength,
    depth,
    pathIndex,
  };
}

function makeBlockedBranch(reason, edge, depth, nextDepth, pathNodes, pathEdges, extra = {}) {
  return {
    reason,
    edgeId: edge.edgeId || null,
    from: edge.from || null,
    to: edge.to || null,
    relation: edge.relation || null,
    depth,
    nextDepth,
    pathNodeIds: clonePath(pathNodes),
    pathEdgeIds: clonePath(pathEdges),
    ...extra,
  };
}

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
