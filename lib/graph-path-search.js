'use strict';

/**
 * DFS path search with timeout and depth protection.
 *
 * Extracted from `lib/graph-traversal.js` (#2232): that file was doing three
 * jobs -- chain walking, cycle search and path search -- and only its length
 * said so. The code below is moved, not rewritten, and
 * `lib/graph-traversal.js` re-exports these names, so every existing require
 * of that path resolves to the same functions.
 */

// r3: findPathWithTimeout - DFS path finding with timeout protection
// Prevents infinite recursion or excessive backtracking in cyclic graphs
function findPathWithTimeout(graph, from, to, timeoutMs = 100, workspaceId = 'default', maxDepth = 5) {
  const startTime = Date.now();
  const visited = new Set();
  const pathArr = [];
  let stoppedReason = null;

  const search = (current, depth) => {
    // r3: Check timeout on each recursion step
    if (Date.now() - startTime > timeoutMs) {
      stoppedReason = 'timeout';
      return null; // Timeout - abort search
    }

    if (depth <= 0) {
      stoppedReason = stoppedReason || 'maxDepth';
      return null;
    }

    if (visited.has(current)) {
      stoppedReason = stoppedReason || 'cycle';
      return null;
    }

    visited.add(current);
    pathArr.push(current);

    if (current === to) return [...pathArr];

    // Forward search
    const edges = graph.getEdges(current, workspaceId);
    for (const e of edges) {
      const result = search(e.to, depth - 1);
      if (result) return result;
    }

    // Backward search
    const inEdges = graph.getInEdges(current, workspaceId);
    for (const e of inEdges) {
      const result = search(e.from, depth - 1);
      if (result) return result;
    }

    pathArr.pop();
    visited.delete(current);
    return null;
  };

  const path = search(from, maxDepth);
  if (!path && !stoppedReason) stoppedReason = 'not_found';
  return {
    path,
    stoppedReason,
    maxDepth,
    timeoutMs,
    workspaceId,
    visitedCount: visited.size,
  };
}

function findPath(graph, from, to, visited, pathArr, depth, workspaceId = 'default') {
  return findPathWithTimeout(graph, from, to, 100, workspaceId, depth).path;
}

module.exports = {
  findPath,
  findPathWithTimeout,
};
