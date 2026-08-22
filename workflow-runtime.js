const WorkflowAgent = require('./workflow-agent');
const { ToolRegistry } = require('./workflow-agent');
const { registerDefaultWorkflowTools } = require('./workflow-tools');

function createWorkflowRuntime(kernel, opts = {}) {
  const registry = opts.registry instanceof ToolRegistry
    ? opts.registry
    : new ToolRegistry({ internalTools: opts.internalTools || [] });

  const agent = opts.agent instanceof WorkflowAgent
    ? opts.agent
      : new WorkflowAgent({
        ...opts,
        registry,
      });

  if (opts.registerDefaultTools !== false) {
    registerDefaultWorkflowTools(registry, kernel, {
      runCapabilityPolicy: opts.runCapabilityPolicy,
    });
  }

  return {
    kind: 'workflow',
    runtime: 'workflow',
    kernel,
    registry,
    agent,
    plan(goal, planOpts = {}) {
      return agent.plan(goal, planOpts);
    },
    run(goal, runOpts = {}) {
      return agent.run(goal, runOpts);
    },
    listTools() {
      return registry.listTools();
    },
    async runTool(name, input, context = {}) {
      return registry.runTool(name, input, context);
    },
    inspectToolPolicy(tool, input, context = {}) {
      if (kernel && typeof kernel.inspectToolPolicy === 'function') {
        return kernel.inspectToolPolicy(tool, input, context);
      }
      return {
        ok: false,
        type: 'policy',
        data: {
          tool,
          action: 'review',
          blocked: false,
          requiresApproval: false,
          labels: ['workflow-runtime'],
          reasons: ['Workflow runtime does not expose policy inspection.'],
        },
        evidence: [],
        error: null,
        meta: {
          runtime: 'workflow',
        },
      };
    },
    countPendingToolApprovals() {
      return 0;
    },
    listPendingToolApprovals() {
      return [];
    },
    getStatus() {
      const agentStatus = typeof agent.lastRun === 'object' && agent.lastRun
        ? {
            goal: agent.lastRun.goal,
            status: agent.lastRun.status,
            completedSteps: agent.lastRun.completedSteps,
            nextAction: agent.lastRun.nextAction,
            confidence: agent.lastRun.confidence,
          }
        : null;

      return {
        agent: 'workflow',
        tools: registry.listTools().length,
        lastPlan: agent.lastPlan || null,
        lastRun: agentStatus,
      };
    },
  };
}

module.exports = {
  createWorkflowRuntime,
};
