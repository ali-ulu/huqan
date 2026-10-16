'use strict';

/**
 * Graph walk primitives (forward/backward chains, cycle detection, bounded
 * path search).
 *
 * This module is the public entry point for the walk primitives. #2232 split
 * them by responsibility -- chain walking into `lib/graph-chain-traversal.js`,
 * cycle search into `lib/graph-cycle-search.js`, path search into
 * `lib/graph-path-search.js` -- because the single file was carrying three
 * distinct jobs and only its length said so. The names, the signatures and the
 * return shapes are unchanged: this file re-exports them, so kernel.js,
 * lib/memory-blast-radius.js and the test suite keep requiring the same path.
 *
 * Every function takes the graph as its first argument instead of reading
 * `this.graph`, so this module has no import back into kernel.js. Kernel
 * keeps the `_forwardChain` / `_backwardChain` / `_detectCycle` /
 * `_resolveCycleOrder` / `_findPath` / `_findPathWithTimeout` methods as thin
 * delegators: lib/kernel-read-use-cases.js receives them as injected
 * callbacks, lib/verify.js calls `kernel._findPathWithTimeout(...)`, and the
 * test suite calls them off a kernel instance.
 */

const {
  CHAIN_DEFAULT_MAX_NODES,
  CHAIN_DEFAULT_TIMEOUT_MS,
  CHAIN_STOPPED,
  forwardChain,
  backwardChain,
  forwardChainBounded,
  backwardChainBounded,
} = require('./graph-chain-traversal');
const {
  CYCLE_DEFAULT_MAX_DEPTH,
  CYCLE_DEFAULT_MAX_NODES,
  CYCLE_DEFAULT_TIMEOUT_MS,
  CYCLE_STOPPED,
  detectCycle,
  detectCycleBounded,
  detectCycleResult,
  resolveCycleOrder,
} = require('./graph-cycle-search');
const {
  findPath,
  findPathWithTimeout,
} = require('./graph-path-search');

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
