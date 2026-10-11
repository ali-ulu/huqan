'use strict';

/**
 * Cycle detection with explicit budgets, and cycle ordering.
 *
 * Extracted from `lib/graph-traversal.js` (#2232): that file was doing three
 * jobs -- chain walking, cycle search and path search -- and only its length
 * said so. The code below is moved, not rewritten, and
 * `lib/graph-traversal.js` re-exports these names, so every existing require
 * of that path resolves to the same functions.
 */

/**
 * Budgets for detectCycle (#743).
 *
 * detectCycle() used to recurse with no depth, work or time limit, while its
 * neighbour findPathWithTimeout() has had all three since it was written.
 * reason() calls it directly and ask() routes "neden/niçin/niye" questions into
 * reason(), so a deep enough chain in a workspace could drive the traversal to
 * Node's call-stack limit and throw RangeError out of a read. The graph size
 * ceiling does not make recursion depth safe: a few thousand nested frames is
 * enough.
 */
const CYCLE_DEFAULT_MAX_DEPTH = 512;
const CYCLE_DEFAULT_MAX_NODES = 50_000;
const CYCLE_DEFAULT_TIMEOUT_MS = 100;

const CYCLE_STOPPED = Object.freeze({
  COMPLETE: '',
  MAX_DEPTH: 'max_depth',
  MAX_NODES: 'max_nodes',
  TIMEOUT: 'timeout',
});

/**
 * Iterative cycle detection with explicit budgets.
 *
 * The search follows edges in their stated direction only (out-edges). It used
 * to also walk in-edges as if they were out-edges, which made a directed graph
 * behave as undirected: any two nodes sharing a parent were reported as a cycle
 * (`hayvan -> kedi -> hayvan` for `kedi -> hayvan` and `kopek -> hayvan`), and
 * `reason()` then printed a fabricated loop and a bogus "ilk neden". A cycle in
 * a directed graph is a path that follows edge direction back to a visited
 * node, so in-edges must not be traversed.
 *
 * @returns {{cycle: string[]|null, stoppedReason: string, visitedCount: number}}
 *   stoppedReason is '' when the search finished within budget. A non-empty
 *   value means the answer is incomplete, not that no cycle exists.
 */
function detectCycleBounded(graph, start, opts = {}) {
  const workspaceId = opts.workspaceId || 'default';
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth > 0
    ? opts.maxDepth : CYCLE_DEFAULT_MAX_DEPTH;
  const maxNodes = Number.isInteger(opts.maxNodes) && opts.maxNodes > 0
    ? opts.maxNodes : CYCLE_DEFAULT_MAX_NODES;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs : CYCLE_DEFAULT_TIMEOUT_MS;

  const visited = opts.visited instanceof Set ? opts.visited : new Set();
  const startedAt = Date.now();
  // `opts.clone === false` opts the search into the frozen edge views (#3012).
  // Only a read use case that copies every field it returns sets it; the
  // default stays a detached clone, as every read API promises (#732).
  const readOptions = opts.clone === false ? { clone: false } : {};
  const stack = [{ node: start, path: opts.pathArr ? [...opts.pathArr] : [], phase: 'enter' }];
  let stoppedReason = CYCLE_STOPPED.COMPLETE;

  while (stack.length > 0) {
    if (visited.size >= maxNodes) { stoppedReason = CYCLE_STOPPED.MAX_NODES; break; }
    if (Date.now() - startedAt > timeoutMs) { stoppedReason = CYCLE_STOPPED.TIMEOUT; break; }

    const frame = stack[stack.length - 1];

    if (frame.phase === 'enter') {
      if (visited.has(frame.node)) {
        const idx = frame.path.indexOf(frame.node);
        if (idx >= 0) {
          return { cycle: frame.path.slice(idx).concat(frame.node), stoppedReason, visitedCount: visited.size };
        }
        stack.pop();
        continue;
      }
      if (frame.path.length >= maxDepth) {
        // Stop descending this branch, but keep searching the rest: a shallow
        // cycle elsewhere is still a real answer.
        stoppedReason = CYCLE_STOPPED.MAX_DEPTH;
        stack.pop();
        continue;
      }
      visited.add(frame.node);
      frame.path = [...frame.path, frame.node];
      frame.edges = graph.getEdges(frame.node, workspaceId, readOptions);
      frame.index = 0;
      frame.phase = 'out';
      continue;
    }

    if (frame.index < frame.edges.length) {
      const edge = frame.edges[frame.index++];
      stack.push({ node: edge.to, path: [...frame.path], phase: 'enter' });
      continue;
    }
    stack.pop();
  }

  return { cycle: null, stoppedReason, visitedCount: visited.size };
}

/**
 * Detailed signature-compatible cycle search result. `visited` is still mutated
 * in place for callers that inspect it afterwards, while `stoppedReason` keeps
 * an incomplete search distinct from a completed search with no cycle.
 */
function detectCycleResult(graph, start, visited, pathArr, workspaceId = 'default', opts = {}) {
  return detectCycleBounded(graph, start, {
    ...opts,
    workspaceId,
    visited: visited instanceof Set ? visited : new Set(),
    pathArr: Array.isArray(pathArr) ? pathArr : [],
  });
}

/**
 * Legacy wrapper: preserve the historical cycle|null return shape for callers
 * that do not need the bounded-search status.
 */
function detectCycle(graph, start, visited, pathArr, workspaceId = 'default', opts = {}) {
  return detectCycleResult(graph, start, visited, pathArr, workspaceId, opts).cycle;
}

function resolveCycleOrder(graph, cycle, workspaceId = 'default', opts = {}) {
  const readOptions = opts.clone === false ? { clone: false } : {};
  const giren = new Set();
  const cikan = new Set();
  for (let i = 0; i < cycle.length - 1; i++) {
    const edges = graph.getEdges(cycle[i], workspaceId, readOptions);
    for (const e of edges) {
      if (e.to === cycle[i + 1] && e.relation === 'tür') {
        cikan.add(cycle[i]);
        giren.add(cycle[i + 1]);
      }
    }
  }
  for (const n of cycle) {
    if (cikan.has(n) && !giren.has(n)) return n + ' (döngü başlangıcı)';
  }
  return null;
}

module.exports = {
  CYCLE_DEFAULT_MAX_DEPTH,
  CYCLE_DEFAULT_MAX_NODES,
  CYCLE_DEFAULT_TIMEOUT_MS,
  CYCLE_STOPPED,
  detectCycleBounded,
  detectCycleResult,
  detectCycle,
  resolveCycleOrder,
};
