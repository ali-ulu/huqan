'use strict';

// Plan method group of AgentV3 (#2120): plan() plus the step-runtime seam.
// Moved verbatim out of agent.v3.js; installed on AgentV3.prototype by
// lib/agent-v3-method-install.js so the public surface is unchanged.
const { normalizeAgentV3WorkspaceId } = require('./agent-v3-workspace');
const { annotatePlanWithGoalMemory } = require('./agent-v3-plan-memory');
const { labelPlanDataForDreamLoop } = require('./agent-v3-dream-loop-adapter');
const { cloneValue } = require('./agent-v3-run-state');

class AgentV3PlanMethods {
  plan(goal, opts = {}) {
    const result = this.baseAgent.plan(goal, { ...opts, maxSteps: opts.maxSteps || this.maxSteps });
    if (!result || result.ok === false) return result;
    // Scoped: goal memory used to be global by goal text, so planning the same
    // goal returned another workspace's history (#757). Normalized so this read
    // keys the workspace run() will use, and so a non-string id fails
    // structurally below rather than as a raw storage TypeError.
    const workspace = normalizeAgentV3WorkspaceId(opts.workspaceId);
    if (!workspace.ok) return this.fail('agent', 'AGENT_WORKSPACE_ID_INVALID', workspace.message, [], { workspaceId: opts.workspaceId });
    let memory;
    try {
      memory = this.storage.getGoalMemory(goal, workspace.workspaceId);
    } catch (err) {
      return this._storageFailure('getGoalMemory', err);
    }
    const data = cloneValue(result.data);
    labelPlanDataForDreamLoop(data, opts, this.kernel, this.dreamExperimentLoop);
    annotatePlanWithGoalMemory(data, memory, goal);
    data.recommendations = this._runtime().buildRunRecommendations({
      goal: data.goal,
      objective: data.objective,
      steps: [],
      progress: { stalledCount: 0, lastSummary: '' },
      status: 'running',
    });
    this.lastPlan = data;
    return this.ok('plan', data, result.evidence || [], result.meta || {});
  }

  /** The step-execution seam of the agent underneath. See Agent.stepRuntime. */
  stepRuntime() {
    return this._runtime();
  }

  _runtime() {
    if (!this._baseRuntime) this._baseRuntime = this.baseAgent.stepRuntime();
    return this._baseRuntime;
  }
}

module.exports = { AgentV3PlanMethods };
