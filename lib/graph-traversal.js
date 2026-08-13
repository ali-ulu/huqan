'use strict';

/**
 * Graph walk primitives (forward/backward chains, cycle detection, bounded
 * path search), lifted out of kernel.js verbatim.
 *
 * Every function takes the graph as its first argument instead of reading
 * `this.graph`, so this module has no import back into kernel.js. Kernel
 * keeps the `_forwardChain` / `_backwardChain` / `_detectCycle` /
 * `_resolveCycleOrder` / `_findPath` / `_findPathWithTimeout` methods as thin
 * delegators: lib/kernel-read-use-cases.js receives them as injected
 * callbacks, lib/verify.js calls `kernel._findPathWithTimeout(...)`, and the
 * test suite calls them off a kernel instance.
 */

function forwardChain(graph, id, chain, visited, depth, workspaceId = 'default') {
  if (depth <= 0 || visited.has(id)) return chain;
  visited.add(id);
  const edges = graph.getEdges(id, workspaceId);
  for (const e of edges) {
    if (!visited.has(e.to) && !chain.some(c => c.to === e.to)) {
      chain.push(e);
      forwardChain(graph, e.to, chain, visited, depth - 1, workspaceId);
    }
  }
  return chain;
}

function backwardChain(graph, id, chain, visited, depth, workspaceId = 'default') {
  if (depth <= 0 || visited.has(id)) return chain;
  visited.add(id);
  const inEdges = graph.getInEdges(id, workspaceId);
  for (const e of inEdges) {
    if (!visited.has(e.from) && !chain.some(c => c.from === e.from)) {
      chain.push(e);
      backwardChain(graph, e.from, chain, visited, depth - 1, workspaceId);
    }
  }
  return chain;
}

function detectCycle(graph, start, visited, pathArr, workspaceId = 'default') {
  if (visited.has(start)) {
    const idx = pathArr.indexOf(start);
    if (idx >= 0) return pathArr.slice(idx).concat(start);
    return null;
  }
  visited.add(start);
  pathArr.push(start);
  const edges = graph.getEdges(start, workspaceId);
  for (const e of edges) {
    const result = detectCycle(graph, e.to, visited, [...pathArr], workspaceId);
    if (result) return result;
  }
  const inEdges = graph.getInEdges(start, workspaceId);
  for (const e of inEdges) {
    if (!visited.has(e.from)) {
      const result = detectCycle(graph, e.from, visited, [...pathArr], workspaceId);
      if (result) return result;
    }
  }
  return null;
}

function resolveCycleOrder(graph, cycle, workspaceId = 'default') {
  const giren = new Set();
  const cikan = new Set();
  for (let i = 0; i < cycle.length - 1; i++) {
    const edges = graph.getEdges(cycle[i], workspaceId);
    for (const e of edges) {
      if (e.to === cycle[i + 1] && e.relation === 'tür') {
        cikan.add(cycle[i]);
        giren.add(cycle[i + 1]);
      }
    }
  }
  for (const n of cycle) {
    if (cikan.has(n) && !giren.has(n)) return n + ' (root type)';
  }
  return null;
}

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
  forwardChain,
  backwardChain,
  detectCycle,
  resolveCycleOrder,
  findPath,
  findPathWithTimeout,
};
