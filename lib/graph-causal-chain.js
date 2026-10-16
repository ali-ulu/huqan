'use strict';

const {
  compareCausalEdges,
  normalizeCausalStep,
  normalizeWorkspaceId,
  attachTraversalMeta,
} = require('./graph-record-utils');

/**
 * Delegated from Graph#getCausalChain for the #328 god-module refactor.
 *
 * This is a mechanical ownership extraction: the traversal keeps the exact
 * queue, loop detection, depth stopping, confidence aggregation, workspace
 * forwarding, and JSON-safe metadata behavior that Graph previously owned.
 * Graph remains responsible for node/edge storage and exposes only its public
 * read methods through the receiver passed here.
 */
function getCausalChain(graph, fromId, maxDepthOrOpts = 10) {
  const opts = typeof maxDepthOrOpts === 'object' && maxDepthOrOpts !== null
    ? maxDepthOrOpts
    : { maxDepth: maxDepthOrOpts };
  const maxDepth = Number.isFinite(opts.maxDepth) ? Math.max(0, opts.maxDepth) : 10;
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);

  const chain = [];
  const visited = [];
  const visitedSet = new Set();
  const loops = [];
  const queue = [{ node: fromId, depth: 0, path: [], pathNodes: [fromId] }];
  let stoppedReason = graph.getNode(fromId, workspaceId) ? 'exhausted' : 'missing-start-node';
  let confidenceTotal = 0;
  let confidenceCount = 0;
  let depthStopped = false;

  if (!graph.getNode(fromId, workspaceId)) {
    return attachTraversalMeta(chain, {
      start: fromId,
      visited,
      loops,
      stoppedReason,
      maxDepth,
      confidence: 0,
    });
  }

  while (queue.length > 0) {
    const { node, depth, path, pathNodes } = queue.shift();
    if (depth >= maxDepth) {
      depthStopped = true;
      continue;
    }
    if (!visitedSet.has(node)) {
      visitedSet.add(node);
      visited.push(node);
    }

    const causalEdges = graph.getCausalEdges(node, workspaceId);
    for (const edge of causalEdges) {
      const step = normalizeCausalStep(edge);
      const newPath = [...path, step];
      chain.push(newPath);
      confidenceTotal += step.confidence ?? 0;
      confidenceCount += 1;

      if (pathNodes.includes(edge.to)) {
        loops.push([...pathNodes, edge.to]);
        continue;
      }

      queue.push({
        node: edge.to,
        depth: depth + 1,
        path: newPath,
        pathNodes: [...pathNodes, edge.to],
      });
    }
  }

  if (depthStopped) {
    stoppedReason = 'maxDepth';
  }

  return attachTraversalMeta(chain, {
    start: fromId,
    visited,
    loops,
    stoppedReason,
    maxDepth,
    confidence: confidenceCount > 0 ? confidenceTotal / confidenceCount : 0,
  });
}

module.exports = { getCausalChain };
