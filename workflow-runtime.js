const WorkflowAgent = require('./workflow-agent');
const {
  ToolRegistry,
  normalizeConfidence,
  normalizeEvidence,
  normalizeError,
} = require('./workflow-agent');
const { registerDefaultWorkflowTools } = require('./workflow-tools');

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeRuntimeOutput(toolName, result, fallbackData = null, meta = {}) {
  const hasEnvelope = result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok');
  const ok = hasEnvelope ? Boolean(result.ok) : true;
  const rawData = hasEnvelope
    ? (result.data !== undefined ? result.data : result)
    : (result !== undefined ? result : fallbackData);
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) && fallbackData && typeof fallbackData === 'object' && !Array.isArray(fallbackData)
    ? { ...cloneValue(fallbackData), ...cloneValue(rawData) }
    : cloneValue(rawData);
  const evidence = hasEnvelope ? (result.evidence || []) : [];
  const confidence = hasEnvelope
    ? (result.data && typeof result.data.confidence === 'number'
      ? result.data.confidence
      : result.confidence ?? fallbackData?.confidence ?? 0.5)
    : (fallbackData && typeof fallbackData.confidence === 'number' ? fallbackData.confidence : 0.5);

  return {
    ok,
    tool: toolName,
    status: ok ? 'done' : 'error',
    data,
    output: cloneValue(data),
    evidence: normalizeEvidence(evidence),
    confidence: normalizeConfidence(confidence, ok ? 0.5 : 0),
    error: ok ? null : normalizeError(hasEnvelope ? result.error : null, 'ERROR', 'Tool execution failed.'),
    trace: [{
      phase: 'runtime',
      tool: toolName,
      status: ok ? 'done' : 'error',
      evidenceCount: normalizeEvidence(evidence).length,
      confidence: normalizeConfidence(confidence, ok ? 0.5 : 0),
    }],
    errors: ok ? [] : [normalizeError(hasEnvelope ? result.error : null, 'ERROR', 'Tool execution failed.')],
    meta: {
      tool: toolName,
      adapter: 'workflow-runtime',
      ...meta,
    },
  };
}

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
    registerDefaultWorkflowTools(registry, kernel);
  }

  return {
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
      const tool = typeof registry._getToolRecord === 'function'
        ? registry._getToolRecord(name)
        : registry.getTool(name);
      if (!tool) {
        return registry.runTool(name, input, context);
      }

      try {
        const result = tool.run(cloneValue(context), cloneValue(input));
        const resolved = result && typeof result.then === 'function' ? await result : result;
        return normalizeRuntimeOutput(tool.name || name, resolved, null, {
          source: 'workflow-runtime',
        });
      } catch (error) {
        return normalizeRuntimeOutput(tool.name || name, {
          ok: false,
          error,
        }, null, {
          source: 'workflow-runtime',
        });
      }
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
