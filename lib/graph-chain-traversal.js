'use strict';

/**
 * Forward/backward chain walking with work and time budgets.
 *
 * Extracted from `lib/graph-traversal.js` (#2232): that file was doing three
 * jobs -- chain walking, cycle search and path search -- and only its length
 * said so. The code below is moved, not rewritten, and
 * `lib/graph-traversal.js` re-exports these names, so every existing require
 * of that path resolves to the same functions.
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

module.exports = {
  CHAIN_STOPPED,
  CHAIN_DEFAULT_MAX_NODES,
  CHAIN_DEFAULT_TIMEOUT_MS,
  forwardChain,
  backwardChain,
  forwardChainBounded,
  backwardChainBounded,
};
