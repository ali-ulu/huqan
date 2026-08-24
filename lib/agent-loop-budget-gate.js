'use strict';

/**
 * AB10 — Agent Loop Budget Gate.
 *
 * agent.v3.js already enforces a per-call budget (maxIterations,
 * timeBudgetMs) that pauses a single run() when exceeded. That budget does
 * not persist across separate run() calls, so a caller could restart run()
 * repeatedly to exhaust resources for a workspace over time. This module is
 * the decision logic for a durable, workspace-scoped ceiling on top of that:
 * given how many iterations a workspace has already spent inside the
 * current window, decide whether a new run should be allowed, reviewed, or
 * blocked.
 *
 * Deliberately pure: it takes already-computed usage numbers and returns a
 * decision, it does not read or write storage itself (see agent.v3.js for
 * the storage-backed usage lookup via HuqanStorage.sumAgentIterationsSince).
 *
 * Deliberately does NOT track a token budget: nothing in this codebase
 * counts LLM tokens today (no llmAdapter call site records usage), so a
 * `maxTokens` counter would have no real data behind it. Shipping a fake
 * counter would be an overclaim, not a safety feature; token budgeting is
 * left as an explicit non-goal until real token accounting exists.
 */

const AGENT_LOOP_BUDGET_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
});

const AGENT_LOOP_BUDGET_REASONS = Object.freeze({
  WITHIN_BUDGET: 'within_budget',
  APPROACHING_LIMIT: 'approaching_iteration_limit',
  LIMIT_EXCEEDED: 'iteration_limit_exceeded',
});

const DEFAULT_MAX_ITERATIONS_PER_WINDOW = 200;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_REVIEW_THRESHOLD_RATIO = 0.8;

/**
 * @param {object} input
 * @param {number} input.iterationsUsed - iterations already spent in the current window (before this run)
 * @param {number} [input.requestedIterations] - iterations this run intends to spend at most (defaults to 1: "is there room for at least one more iteration")
 * @param {object} [opts]
 * @param {number} [opts.maxIterationsPerWindow]
 * @param {number} [opts.reviewThresholdRatio] - fraction of the budget at which ALLOW downgrades to REVIEW
 */
function evaluateAgentLoopBudget(input = {}, opts = {}) {
  const maxIterationsPerWindow = Number.isFinite(opts.maxIterationsPerWindow) && opts.maxIterationsPerWindow > 0
    ? opts.maxIterationsPerWindow
    : DEFAULT_MAX_ITERATIONS_PER_WINDOW;
  const reviewThresholdRatio = Number.isFinite(opts.reviewThresholdRatio) && opts.reviewThresholdRatio > 0 && opts.reviewThresholdRatio <= 1
    ? opts.reviewThresholdRatio
    : DEFAULT_REVIEW_THRESHOLD_RATIO;

  const iterationsUsed = Math.max(0, Number(input.iterationsUsed) || 0);
  const requestedIterations = Number.isFinite(input.requestedIterations) && input.requestedIterations > 0
    ? input.requestedIterations
    : 1;

  const projected = iterationsUsed + requestedIterations;

  if (iterationsUsed >= maxIterationsPerWindow || projected > maxIterationsPerWindow) {
    return {
      decision: AGENT_LOOP_BUDGET_DECISIONS.BLOCK,
      reason: AGENT_LOOP_BUDGET_REASONS.LIMIT_EXCEEDED,
      iterationsUsed,
      maxIterationsPerWindow,
      remaining: Math.max(0, maxIterationsPerWindow - iterationsUsed),
    };
  }

  if (projected >= maxIterationsPerWindow * reviewThresholdRatio) {
    return {
      decision: AGENT_LOOP_BUDGET_DECISIONS.REVIEW,
      reason: AGENT_LOOP_BUDGET_REASONS.APPROACHING_LIMIT,
      iterationsUsed,
      maxIterationsPerWindow,
      remaining: Math.max(0, maxIterationsPerWindow - iterationsUsed),
    };
  }

  return {
    decision: AGENT_LOOP_BUDGET_DECISIONS.ALLOW,
    reason: AGENT_LOOP_BUDGET_REASONS.WITHIN_BUDGET,
    iterationsUsed,
    maxIterationsPerWindow,
    remaining: Math.max(0, maxIterationsPerWindow - iterationsUsed),
  };
}

module.exports = {
  AGENT_LOOP_BUDGET_DECISIONS,
  AGENT_LOOP_BUDGET_REASONS,
  DEFAULT_MAX_ITERATIONS_PER_WINDOW,
  DEFAULT_WINDOW_MS,
  DEFAULT_REVIEW_THRESHOLD_RATIO,
  evaluateAgentLoopBudget,
};
