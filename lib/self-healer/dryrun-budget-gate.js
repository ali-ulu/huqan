'use strict';

/**
 * AB10 loop-budget gate for the self-healer dry-run.
 *
 * Extracted from `dryrun-runner.js`: a workspace that has burned through its
 * loop budget does not get to generate more proposals, however safe those
 * proposals would be. This is the runaway-loop stop, so it runs before any
 * finding is examined.
 *
 * `iterationsUsed` is supplied by the caller (no module here owns storage).
 * A caller that omits it gets a budget evaluated against zero usage, which
 * effectively disables the ceiling -- so that case is reported as
 * `usageKnown: false` rather than being indistinguishable from a genuinely
 * fresh workspace. The run is still allowed to proceed because it has no side
 * effects at all (`applied` is always false); what must not happen is a
 * consumer reading the run result as budget-verified when no usage was ever
 * measured.
 *
 * The code is moved, not rewritten: the decision arithmetic is byte identical
 * to its previous form in `dryrun-runner.js`; `processCount` encodes the same
 * `findings.slice(0, Math.max(0, Math.floor(budget.remaining)))` bound as a
 * count so the runner does not need the findings array to apply the gate.
 */

const {
  AGENT_LOOP_BUDGET_DECISIONS,
  evaluateAgentLoopBudget,
} = require('../agent-loop-budget-gate');

/**
 * True only for a real, finite numeric usage figure. `null`, `undefined`,
 * `''` and `NaN` all coerce to 0 through `Number()`, which is exactly how a
 * missing measurement silently becomes "no budget spent" -- so they are
 * rejected here rather than coerced.
 */
function isFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

/**
 * @param {object} input
 * @param {number} input.findingCount number of normalized findings in the run
 * @param {number} [input.iterationsUsed] measured usage in the current window
 * @param {number} [input.maxIterationsPerWindow] AB10 override
 * @returns {object} the gate decision; `processCount` is how many findings
 *   the run may turn into proposals, `blocked` stops the run outright
 */
function evaluateDryRunBudget(input = {}) {
  const findingCount = input.findingCount || 0;
  const usageKnown = isFiniteNumber(input.iterationsUsed);
  const budget = evaluateAgentLoopBudget(
    {
      iterationsUsed: usageKnown ? Number(input.iterationsUsed) : 0,
      requestedIterations: findingCount || 1,
    },
    { maxIterationsPerWindow: input.maxIterationsPerWindow },
  );

  if (budget.decision === AGENT_LOOP_BUDGET_DECISIONS.BLOCK) {
    return {
      usageKnown,
      budget,
      blocked: true,
      budgetReviewRequired: false,
      budgetTruncated: false,
      processCount: 0,
    };
  }

  const budgetReviewRequired = budget.decision === AGENT_LOOP_BUDGET_DECISIONS.REVIEW;
  const processCount = budgetReviewRequired
    ? Math.min(Math.max(0, Math.floor(budget.remaining)), findingCount)
    : findingCount;

  return {
    usageKnown,
    budget,
    blocked: false,
    budgetReviewRequired,
    budgetTruncated: processCount < findingCount,
    processCount,
  };
}

module.exports = { evaluateDryRunBudget };
