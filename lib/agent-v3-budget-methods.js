'use strict';

// Budget-gate method group of AgentV3 (#2120): the AB10 durable-budget
// wrappers. Moved verbatim out of agent.v3.js; installed on AgentV3.prototype
// by lib/agent-v3-method-install.js so the public surface is unchanged.
const { evaluateAgentV3LoopBudget, unavailableBudget } = require('./agent-v3-loop-budget');

class AgentV3BudgetMethods {
  /**
   * AB10: looks up durable per-workspace usage and evaluates it against the
   * budget gate. Fail-closed behavior and rationale live in
   * lib/agent-v3-loop-budget.js, which this delegates to.
   *
   * @param {string} workspaceId
   * @param {object} [opts]
   * @param {number} [requestedIterations] iterations this run can actually
   *   perform; defaults to the configured per-call ceiling when not supplied.
   */
  _checkAgentLoopBudget(workspaceId, opts = {}, requestedIterations = null) {
    return evaluateAgentV3LoopBudget({
      storage: this.storage,
      kernel: this.kernel,
      maxIterationsPerWindow: this.maxIterationsPerWindow,
      agentLoopBudgetWindowMs: this.agentLoopBudgetWindowMs,
      maxIterations: this.maxIterations,
    }, workspaceId, opts, requestedIterations);
  }

  /**
   * Returns `opts` with the run's workspace forced onto the per-tool option
   * bags agent.js reads.
   *
   * The run-level workspace is authoritative and overrides a per-tool value
   * on purpose: the alternative is a run whose budget and run record name one
   * workspace while its steps mutate another, which makes the durable AB10
   * accounting describe a workspace that was never touched.
   */
  _withWorkspaceScope(opts = {}, workspaceId) {
    const scoped = { ...opts, workspaceId };
    for (const key of ['learnOpts', 'askOpts', 'verifyOpts', 'reasonOpts', 'compareOpts', 'dreamOpts']) {
      const existing = opts[key] && typeof opts[key] === 'object' && !Array.isArray(opts[key])
        ? opts[key]
        : {};
      scoped[key] = { ...existing, workspaceId };
    }
    return scoped;
  }

  _unavailableBudget(maxIterationsPerWindow, detail) {
    return unavailableBudget(maxIterationsPerWindow, detail);
  }
}

module.exports = { AgentV3BudgetMethods };
