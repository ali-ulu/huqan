'use strict';

// #2194: the graph lookups (node and outgoing-edge resolvers) and the entry
// and blocked-branch records produced by the causal traversal.

const { CAUSAL_EDGE_RELATIONS } = require('./causal-edge');
const { clonePath, getEdgeFrom, getEdgeRelation, getEdgeTo } = require('./causal-traversal-edges');

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

module.exports = {
  getNodeResolver,
  getOutgoingEdgeResolver,
  makeBlockedBranch,
  normalizeTraversalEntry,
};
