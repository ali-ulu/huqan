'use strict';

const { stepHistoryCount } = require('./bounded-step-history');

/**
 * The one vocabulary for why an agent run pauses and why a fractal-learn run
 * stops (#3498).
 *
 * Before this module the pause reasons were spread over agent.v3.js (two of
 * them, one as a bare string), lib/agent-v3-status-methods.js (a bare
 * string) and lib/experience/run-repair.js, and the fractal-learn stop reasons
 * were written twice: once where lib/fractal-learn.js sets them and once by
 * hand in the huqan.fractal-learn output schema enum. A reason added in one
 * place and not the other was a silent contract drift.
 *
 * The values are unchanged; only their source is now single. The published
 * schemas keep their shape (pauseReason stays an open string), so no client
 * sees a difference.
 */

const AGENT_PAUSE_REASONS = Object.freeze({
  TIME_BUDGET_EXCEEDED: 'time_budget_exceeded',
  BUDGET_OR_ITERATION_LIMIT: 'budget_or_iteration_limit',
  REPAIR_PENDING_APPROVAL: 'repair_pending_approval',
  EXPERIENCE_EFFECT_UNCERTAIN: 'experience_effect_uncertain',
  STALLED: 'stalled_without_progress',
});

/**
 * Why an agent run ended, one typed value for every exit (#3494). A pause
 * reason says what the run waits for; this says what stopped the loop, and
 * it tells apart what `budget_or_iteration_limit` used to merge (the plan's
 * step ceiling and the iteration ceiling).
 */
const AGENT_TERMINATION_REASONS = Object.freeze({
  END_OF_PLAN: 'end_of_plan',
  MAX_STEPS: 'max_steps',
  MAX_ITERATIONS: 'max_iterations',
  TIME_BUDGET: 'time_budget',
  STALLED: 'stalled',
  BUDGET_BLOCKED: 'budget_blocked',
  BUDGET_UNAVAILABLE: 'budget_unavailable',
  EMERGENCY_STOP: 'emergency_stop',
  BLOCKED_STEP: 'blocked_step',
  BLOCKED_DREAM_LOOP: 'blocked_dream_loop',
  AWAITING_REPAIR_APPROVAL: 'awaiting_repair_approval',
  AWAITING_EFFECT_VERDICT: 'awaiting_effect_verdict',
  // Work remains but no ceiling explains the stop; never reported as done.
  INCOMPLETE: 'incomplete',
  // The run never entered its loop: a refused request or resume token.
  INVALID_REQUEST: 'invalid_request',
  STORAGE_FAILURE: 'storage_failure',
});

const FRACTAL_LEARN_STOP_REASONS = Object.freeze({
  EXHAUSTED: 'exhausted',
  SATURATED: 'saturated',
  MAX_ROUNDS: 'maxRounds',
});

const PAUSE_TERMINATION = Object.freeze({
  [AGENT_PAUSE_REASONS.TIME_BUDGET_EXCEEDED]: AGENT_TERMINATION_REASONS.TIME_BUDGET,
  [AGENT_PAUSE_REASONS.REPAIR_PENDING_APPROVAL]: AGENT_TERMINATION_REASONS.AWAITING_REPAIR_APPROVAL,
  [AGENT_PAUSE_REASONS.EXPERIENCE_EFFECT_UNCERTAIN]: AGENT_TERMINATION_REASONS.AWAITING_EFFECT_VERDICT,
  [AGENT_PAUSE_REASONS.STALLED]: AGENT_TERMINATION_REASONS.STALLED,
});

function lastStepErrorCode(state) {
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const last = steps[steps.length - 1];
  const error = last && last.result && last.result.error;
  return error && typeof error.code === 'string' ? error.code : null;
}

/**
 * Derive the termination reason from a finished loop's state. `queued` is
 * what is still waiting, `maxSteps` the plan's step ceiling, and
 * `maxIterations` the run's iteration ceiling.
 */
function terminationReasonFor(state, { queued = 0, maxSteps = Infinity, maxIterations = Infinity } = {}) {
  if (state.status === 'blocked') {
    if (state.blockedBy === 'dream-experiment-loop') return AGENT_TERMINATION_REASONS.BLOCKED_DREAM_LOOP;
    if (lastStepErrorCode(state) === 'AGENT_EMERGENCY_STOPPED') return AGENT_TERMINATION_REASONS.EMERGENCY_STOP;
    return AGENT_TERMINATION_REASONS.BLOCKED_STEP;
  }
  if (state.status === 'paused' && Object.hasOwn(PAUSE_TERMINATION, state.pauseReason)) {
    return PAUSE_TERMINATION[state.pauseReason];
  }
  if (queued > 0) {
    const steps = stepHistoryCount(state.steps);
    if (steps >= maxSteps) return AGENT_TERMINATION_REASONS.MAX_STEPS;
    if (state.iteration >= maxIterations) return AGENT_TERMINATION_REASONS.MAX_ITERATIONS;
    return AGENT_TERMINATION_REASONS.INCOMPLETE;
  }
  return AGENT_TERMINATION_REASONS.END_OF_PLAN;
}

module.exports = Object.freeze({
  AGENT_PAUSE_REASONS,
  AGENT_TERMINATION_REASONS,
  FRACTAL_LEARN_STOP_REASONS,
  terminationReasonFor,
});
