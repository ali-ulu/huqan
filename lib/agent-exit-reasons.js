'use strict';

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
});

const FRACTAL_LEARN_STOP_REASONS = Object.freeze({
  EXHAUSTED: 'exhausted',
  SATURATED: 'saturated',
  MAX_ROUNDS: 'maxRounds',
});

module.exports = Object.freeze({
  AGENT_PAUSE_REASONS,
  FRACTAL_LEARN_STOP_REASONS,
});
