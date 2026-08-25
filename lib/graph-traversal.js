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

/**
 * Budgets and de-duplication for forwardChain/backwardChain (#1185).
 *
 * These two sat directly above detectCycleBounded, were reached from the same
 * reason() call, and had neither of the properties it was given:
 *
 * - **Quadratic de-duplication.** `!chain.some(c => c.to === e.to)` is a linear
 *   scan run once per edge, so the cost was O(chain²). Measured on a hub node,
 *   forwardChain at depth 4 took 2.4 ms at fan-out 500 and 42 ms at 4000 --
 *   four times the work for twice the edges. A Set of seen targets makes it
 *   linear and decides exactly the same edges: the set is threaded through the
 *   recursion, so a target added by a nested call is visible to the caller's
 *   loop, which is what re-scanning `chain` achieved.
 * - **No work or time budget.** Only `depth` was bounded, and the single
 *   in-tree caller passes 4, so the recursion depth was safe while the fan-out
 *   was not: kernel.reason() on a 6000-edge hub blocked the event loop for
 *   143 ms, and reason() is reachable from HTTP and MCP with a caller-supplied
 *   subject.
 *
 * The budgets match detectCycleBounded's, for the same reasons its docblock
 * gives. As there, the *Bounded functions report why they stopped, and the
 * legacy wrappers keep the historical array return for callers that do not
 * read the status.
 */
const CHAIN_DEFAULT_MAX_NODES = 50_000;
const CHAIN_DEFAULT_TIMEOUT_MS = 100;

const CHAIN_STOPPED = Object.freeze({
  COMPLETE: '',
  MAX_NODES: 'max_nodes',
  TIMEOUT: 'timeout',
});

function chainBudget(opts = {}) {
  return {
    maxNodes: Number.isInteger(opts.maxNodes) && opts.maxNodes > 0 ? opts.maxNodes : CHAIN_DEFAULT_MAX_NODES,
    timeoutMs: Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : CHAIN_DEFAULT_TIMEOUT_MS,
    startedAt: Date.now(),
    stoppedReason: CHAIN_STOPPED.COMPLETE,
  };
}

function chainBudgetExhausted(budget, visited) {
  if (budget.stoppedReason !== CHAIN_STOPPED.COMPLETE) return true;
  if (visited.size >= budget.maxNodes) { budget.stoppedReason = CHAIN_STOPPED.MAX_NODES; return true; }
  if (Date.now() - budget.startedAt > budget.timeoutMs) { budget.stoppedReason = CHAIN_STOPPED.TIMEOUT; return true; }
  return false;
}

function walkChain(graph, id, chain, visited, depth, workspaceId, budget, seen, direction) {
  if (depth <= 0 || visited.has(id)) return chain;
  if (chainBudgetExhausted(budget, visited)) return chain;
  visited.add(id);
  const edges = direction === 'forward'
    ? graph.getEdges(id, workspaceId)
    : graph.getInEdges(id, workspaceId);
  for (const e of edges) {
    const next = direction === 'forward' ? e.to : e.from;
    if (visited.has(next) || seen.has(next)) continue;
    if (chainBudgetExhausted(budget, visited)) return chain;
    seen.add(next);
    chain.push(e);
    walkChain(graph, next, chain, visited, depth - 1, workspaceId, budget, seen, direction);
  }
  return chain;
}

function runChain(graph, id, chain, visited, depth, workspaceId, opts, direction) {
  const budget = chainBudget(opts);
  const startChain = Array.isArray(chain) ? chain : [];
  const startVisited = visited instanceof Set ? visited : new Set();
  // Seeded from the chain the caller passed in, so a non-empty starting chain
  // suppresses the same targets the `chain.some(...)` scan would have.
  const seen = new Set(startChain.map(item => (direction === 'forward' ? item.to : item.from)));
  walkChain(graph, id, startChain, startVisited, depth, workspaceId || 'default', budget, seen, direction);
  return { chain: startChain, stoppedReason: budget.stoppedReason, visitedCount: startVisited.size };
}

/** @returns {{chain: object[], stoppedReason: string, visitedCount: number}} */
function forwardChainBounded(graph, id, chain, visited, depth, workspaceId = 'default', opts = {}) {
  return runChain(graph, id, chain, visited, depth, workspaceId, opts, 'forward');
}

/** @returns {{chain: object[], stoppedReason: string, visitedCount: number}} */
function backwardChainBounded(graph, id, chain, visited, depth, workspaceId = 'default', opts = {}) {
  return runChain(graph, id, chain, visited, depth, workspaceId, opts, 'backward');
}

/** Legacy wrapper: the historical array return, without the bounded status. */
function forwardChain(graph, id, chain, visited, depth, workspaceId = 'default', opts = {}) {
  return forwardChainBounded(graph, id, chain, visited, depth, workspaceId, opts).chain;
}

/** Legacy wrapper: the historical array return, without the bounded status. */
function backwardChain(graph, id, chain, visited, depth, workspaceId = 'default', opts = {}) {
  return backwardChainBounded(graph, id, chain, visited, depth, workspaceId, opts).chain;
}

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
 * The stack frames mirror the previous recursion exactly — enter, then
 * out-edges, then in-edges — because the two edge directions are not
 * symmetric: an out-edge recurses into an already-visited node so the cycle can
 * be recognised, while an in-edge is skipped when its source is already
 * visited. Evaluating that guard at the same point the recursion did is what
 * keeps the detected cycle identical; batching the children would change which
 * cycle is found.
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
      frame.edges = graph.getEdges(frame.node, workspaceId);
      frame.index = 0;
      frame.phase = 'out';
      continue;
    }

    if (frame.phase === 'out') {
      if (frame.index < frame.edges.length) {
        const edge = frame.edges[frame.index++];
        stack.push({ node: edge.to, path: [...frame.path], phase: 'enter' });
        continue;
      }
      frame.edges = graph.getInEdges(frame.node, workspaceId);
      frame.index = 0;
      frame.phase = 'in';
      continue;
    }

    if (frame.index < frame.edges.length) {
      const edge = frame.edges[frame.index++];
      if (!visited.has(edge.from)) {
        stack.push({ node: edge.from, path: [...frame.path], phase: 'enter' });
      }
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
  CYCLE_DEFAULT_MAX_DEPTH,
  CYCLE_DEFAULT_MAX_NODES,
  CYCLE_DEFAULT_TIMEOUT_MS,
  CYCLE_STOPPED,
  detectCycleBounded,
  detectCycleResult,
  forwardChainBounded,
  backwardChainBounded,
  CHAIN_STOPPED,
  CHAIN_DEFAULT_MAX_NODES,
  CHAIN_DEFAULT_TIMEOUT_MS,
  forwardChain,
  backwardChain,
  detectCycle,
  resolveCycleOrder,
  findPath,
  findPathWithTimeout,
};
