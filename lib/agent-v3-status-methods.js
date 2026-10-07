'use strict';

// Status/report method group of AgentV3 (#2120): checkpoint wrappers, the run
// report renderer and the status endpoint. Moved verbatim out of agent.v3.js;
// installed on AgentV3.prototype by lib/agent-v3-method-install.js so the
// public surface is unchanged.
const { hydrateRunState, saveRunCheckpoint } = require('./agent-v3-run-state');
const { attachStepErrorSummary } = require('./agent-memory-persistence');
const { selectDreamNextAction } = require('./agent-v3-dream-loop-adapter');
const { finalizeAgentRun } = require('./agent-run-finalization');
const { AGENT_PAUSE_REASONS } = require('./agent-exit-reasons');

class AgentV3StatusMethods {
  _hydrateState(activePlan, checkpoint = null) {
    return hydrateRunState(activePlan, checkpoint, { timeBudgetMs: this.timeBudgetMs });
  }

  _saveCheckpoint(state) {
    return saveRunCheckpoint(state, { storage: this.storage });
  }


  _finalizeRunState(state, { goal, workspaceId, activePlan, dreamLoopActive, queued }) {
      if (state.status === 'running') {
        if (queued.length > 0) {
          state.status = 'paused';
          state.pauseReason = state.pauseReason || AGENT_PAUSE_REASONS.BUDGET_OR_ITERATION_LIMIT;
        } else {
          const finalStep = state.steps[state.steps.length - 1];
          state.status = finalStep && finalStep.result && finalStep.result.ok === false ? 'blocked' : 'completed';
        }
      }

      const finalStep = state.steps[state.steps.length - 1];
      const finalSummary = finalStep ? this._runtime().extractAgentSummary(finalStep.result) : { text: '' };
      state.finalAnswer = finalSummary.text || 'Agent completed but no short summary could be produced.';
      attachStepErrorSummary(state);
      state.completedSteps = state.steps.length;
      state.remainingSteps = queued.length;
      state.recommendations = this._runtime().buildRunRecommendations(state);
      state.nextAction = selectDreamNextAction(
        dreamLoopActive,
        state,
        this._runtime().suggestNextAction(state),
      );
      state.report = this._renderReport(state);
      let goalMemory;
      let runs;
      try {
        goalMemory = this.storage.getGoalMemory(goal, workspaceId);
        runs = this.storage.countRuns();
      } catch (err) {
        return { failed: true, result: this._storageFailure('readRunMemory', err, state) };
      }
      state.memory = { path: this.storage.dbPath, goalMemory, runs };
      state.checkpointId = state.checkpointId || state.resumeToken || null;
      state.resumeToken = state.checkpointId;

      // What this run() spent, not the goal's running total: summing the
      // cumulative figure would count a resumed run's earlier iterations again
      // on every resume, exhausting the window budget long before it was
      // genuinely spent.
      state.iterationsDelta = Math.max(0, Number(state.iteration || 0) - Number(state.iterationsAtRunStart || 0));

      const finalized = finalizeAgentRun({
        storage: this.storage,
        state,
        goalMemory: {
          goal,
          workspaceId,
          objective: activePlan.objective,
          status: state.status,
          completedSteps: state.completedSteps,
          finalAnswer: state.finalAnswer,
          resumed: state.resumed,
          selectedTools: activePlan.selectedTools,
        },
        saveCheckpoint: current => this._saveCheckpoint(current),
      });
      if (!finalized.ok) {
        return { failed: true, result: this._storageFailure(finalized.operation, finalized.error, state) };
      }
    return { failed: false };

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
