'use strict';

const {
  evaluateAgentLoopBudget,
  DEFAULT_MAX_ITERATIONS_PER_WINDOW,
  DEFAULT_WINDOW_MS,
} = require('./agent-loop-budget-gate');
const { emitGateTelemetry } = require('./gate-telemetry');

/**
 * AB10 storage-backed budget evaluation for AgentV3.
 *
 * Taken out of `AgentV3._checkAgentLoopBudget` to make room in `agent.v3.js`,
 * which sat at its recorded line-size ceiling, for the Experience runtime
 * seams (#2378). The storage read, the usage-shape validation and the gate
 * decision are one cohesive block; the audit write that accompanies a refusal
 * stays in `agent.v3.js` because ADR-012's source-text tests read that file
 * for it.
 *
 * Fail-closed on an unreadable counter. A storage that does not implement
 * `sumAgentIterationsSince`, or one whose read throws, must not fall back to
 * `iterationsUsed = 0`: that made every run look like a fresh workspace and
 * silently disabled the durable ceiling. Usage that cannot be measured is
 * reported as `usageKnown: false` so the caller refuses the run rather than
 * proceeding unbudgeted.
 */

function unavailableBudget(maxIterationsPerWindow, detail) {
  return {
    decision: 'block',
    reason: 'budget_usage_unavailable',
    detail,
    iterationsUsed: null,
    maxIterationsPerWindow,
    remaining: null,
    usageKnown: false,
  };
}

/**
 * Ask only for what this run can actually spend. Using the configured per-call
 * ceiling instead would project a run that executes at most a couple of steps
 * as if it intended to spend all of them, tripping REVIEW while most of the
 * window budget is genuinely free.
 */
function resolveRequestedIterations(requestedIterations, opts, fallbackMaxIterations) {
  if (Number.isFinite(requestedIterations) && requestedIterations > 0) return requestedIterations;
  return Number.isInteger(opts.maxIterations) ? opts.maxIterations : fallbackMaxIterations;
}

function evaluateAgentV3LoopBudget(deps, workspaceId, opts = {}, requestedIterations = null) {
  const {
    storage,
    kernel,
    maxIterationsPerWindow: configuredMax,
    agentLoopBudgetWindowMs: configuredWindow,
    maxIterations: configuredMaxIterations,
  } = deps;
  const maxIterationsPerWindow = Number.isInteger(opts.maxIterationsPerWindow)
    ? opts.maxIterationsPerWindow
    : configuredMax;
  const windowMs = Number.isInteger(opts.agentLoopBudgetWindowMs)
    ? opts.agentLoopBudgetWindowMs
    : configuredWindow;

  if (typeof storage?.sumAgentIterationsSince !== 'function') {
    return unavailableBudget(maxIterationsPerWindow, 'storage does not implement sumAgentIterationsSince');
  }

  let iterationsUsed;
  try {
    iterationsUsed = storage.sumAgentIterationsSince(workspaceId, Date.now() - windowMs);
  } catch (err) {
    const detail = err && err.message ? err.message : 'unknown error';
    return unavailableBudget(maxIterationsPerWindow, `usage lookup failed: ${detail}`);
  }

  // `null`, `undefined` and `''` all coerce to 0 through Number(), which would
  // read a missing counter as "nothing spent" -- the same fail-open this
  // module exists to close. Reject them before coercing.
  if (iterationsUsed === null || iterationsUsed === undefined || iterationsUsed === ''
    || !Number.isFinite(Number(iterationsUsed))) {
    return unavailableBudget(maxIterationsPerWindow, 'usage lookup returned a non-numeric value');
  }

  const requested = resolveRequestedIterations(requestedIterations, opts, configuredMaxIterations);
  const budgetDecision = evaluateAgentLoopBudget(
    { iterationsUsed: Number(iterationsUsed), requestedIterations: requested },
    { maxIterationsPerWindow },
  );
  emitGateTelemetry(kernel, 'agent-loop-budget', budgetDecision);

  return {
    ...budgetDecision,
    requestedIterations: requested,
    usageKnown: true,
  };
}

module.exports = {
  evaluateAgentV3LoopBudget,
  unavailableBudget,
  resolveRequestedIterations,
  DEFAULT_MAX_ITERATIONS_PER_WINDOW,
  DEFAULT_WINDOW_MS,
};
