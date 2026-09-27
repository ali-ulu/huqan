'use strict';

/**
 * Bounded path search behind `Dream#verify()`, `Dream#amplify()` and
 * `Dream#walk()`, split out of the root `dream.js` (#2120). Every graph read
 * is scoped to the given workspace.
 */

const MAX_VERIFY_DEPTH = 5;

function dfs(graph, current, target, visited, path, depth, workspaceId) {
  if (depth <= 0 || visited.has(current)) return false;
  visited.add(current);
  path.push(current);
  if (current === target) return true;

  for (const e of graph.getEdges(current, workspaceId)) {
    if (!visited.has(e.to) && dfs(graph, e.to, target, visited, path, depth - 1, workspaceId)) return true;
  }
  for (const ie of graph.getInEdges(current, workspaceId)) {
    if (!visited.has(ie.from) && dfs(graph, ie.from, target, visited, path, depth - 1, workspaceId)) return true;
  }

  path.pop();
  visited.delete(current);
  return false;
}

function pathConfidence(graph, path, workspaceId) {
  let conf = 1;
  for (let i = 0; i < path.length - 1; i++) {
    const edge = graph.getEdges(path[i], workspaceId).find(e => e.to === path[i + 1])
              || graph.getInEdges(path[i], workspaceId).find(e => e.from === path[i + 1]);
    if (edge) conf *= edge.weight;
  }
  return conf;
}

function verifyPath(graph, subject, object, workspaceId) {
  const visited = new Set();
  const path    = [];
  const found   = dfs(graph, subject, object, visited, path, MAX_VERIFY_DEPTH, workspaceId);
  if (found) {
    return { valid: true, confidence: pathConfidence(graph, path, workspaceId), path };
  }
  return { valid: false, confidence: 0, path: [] };
}

function greedyWalk(graph, start, maxDepth, workspaceId) {
  const path    = [start];
  const visited = new Set([start]);
  let current   = start;

  for (let i = 0; i < maxDepth; i++) {
    const edges = graph.getEdges(current, workspaceId).filter(e => !visited.has(e.to));
    if (edges.length === 0) break;
    const pick = edges.sort((a, b) => b.weight - a.weight)[0];
    path.push(pick.to);
    visited.add(pick.to);
    current = pick.to;
  }

  return path;
}

module.exports = { verifyPath, greedyWalk };
