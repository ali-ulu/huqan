'use strict';

// Status/report method group of AgentV3 (#2120): checkpoint wrappers, the run
// report renderer and the status endpoint. Moved verbatim out of agent.v3.js;
// installed on AgentV3.prototype by lib/agent-v3-method-install.js so the
// public surface is unchanged.
const { hydrateRunState, saveRunCheckpoint } = require('./agent-v3-run-state');

class AgentV3StatusMethods {
  _hydrateState(activePlan, checkpoint = null) {
    return hydrateRunState(activePlan, checkpoint, { timeBudgetMs: this.timeBudgetMs });
  }

  _saveCheckpoint(state) {
    return saveRunCheckpoint(state, { storage: this.storage });
  }

  _renderReport(state) {
    const baseReport = this._runtime().renderReport(state);
    return [
      `Checkpoint: ${state.checkpointId || 'none'}`,
      `Resume: ${state.resumed ? 'yes' : 'no'}`,
      `Budget remaining: ${Number(state.budgetRemaining || 0)}`,
      baseReport,
    ].join('\n');
  }

  getStatus(workspaceId = 'default') {
    const goals = this.storage ? this.storage.countGoals() : 0;
    const checkpoints = this.storage ? this.storage.countCheckpoints() : 0;
    const runs = this.storage ? this.storage.countRuns() : 0;
    const pendingApprovals = this.storage && typeof this.storage.countPendingToolApprovals === 'function'
      ? this.storage.countPendingToolApprovals(workspaceId)
      : 0;
    const recentApprovals = this.storage && typeof this.storage.listPendingToolApprovals === 'function'
      ? this.storage.listPendingToolApprovals(5, workspaceId).map(item => ({
          id: item.id,
          tool: item.tool,
          status: item.status,
          approvalKey: item.approval_key || item.approvalKey || null,
        }))
      : [];
    return {
      agent: 'v3',
      goals,
      checkpoints,
      runs,
      pendingApprovals,
      recentApprovals,
      lastPlan: this.lastPlan
        ? { goal: this.lastPlan.goal, steps: this.lastPlan.steps.length }
        : null,
      lastRun: this.lastRun
        ? {
            status: this.lastRun.status,
            goal: this.lastRun.goal,
            completedSteps: this.lastRun.completedSteps,
            resumeToken: this.lastRun.resumeToken || null,
            remainingSteps: this.lastRun.remainingSteps,
            finalAnswer: this.lastRun.finalAnswer
          }
        : null
    };
  }
}

module.exports = { AgentV3StatusMethods };
