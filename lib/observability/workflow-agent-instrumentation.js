'use strict';

const crypto = require('node:crypto');
const { writeStructuredLog } = require('../http/structured-log');

function wrapWorkflowAgent(agent, service, defaults = {}) {
  if (!agent || agent.runtime !== 'workflow' || typeof agent.run !== 'function') return agent;
  const originalRun = agent.run.bind(agent);
  agent.run = async (goal, runOptions = {}) => {
    const workspaceId = String(runOptions.workspaceId || defaults.workspaceId || 'default').trim() || 'default';
    const agentId = String(runOptions.agentId || defaults.agentId || '').trim();
    const runId = `workflow-${crypto.randomUUID()}`;
    const traceId = String(runOptions.traceId || runId);
    const correlation = { requestId: runOptions.requestId, runId, traceId };
    const startedAt = Date.now();
    writeStructuredLog(console, 'info', 'observability.workflow_run_started', correlation, { workspaceId, runtime: 'workflow', outcome: 'started' });
    try { service.recordRunStart({ workspaceId, runId, traceId, agentId, runtime: 'workflow', goal, startedAt }); } catch (_) {}
    try {
      const result = await originalRun(goal, runOptions);
      const data = result?.data || result || {};
      const steps = Array.isArray(data.steps) ? data.steps : [];
      for (const step of steps) {
        try { service.recordStep({ workspaceId, runId, traceId: step.traceId || traceId, agentId, status: step.status, tool: step.tool, result: step.output, payload: { stepId: step.id, phase: 'workflow' } }); } catch (_) {}
      }
      const finishedAt = Date.now();
      writeStructuredLog(console, 'info', 'observability.workflow_run_finished', correlation, { workspaceId, runtime: 'workflow', outcome: data.status || (result?.ok ? 'completed' : 'failed'), durationMs: finishedAt - startedAt });
      try { service.recordRunFinish({ workspaceId, runId, traceId, agentId, runtime: 'workflow', goal, objective: data.objective, status: data.status || (result?.ok ? 'completed' : 'failed'), startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt), stepCount: steps.length, successfulSteps: steps.filter(step => step.status === 'done').length, blockedSteps: steps.filter(step => step.status === 'blocked').length, errorSteps: steps.filter(step => ['error', 'review'].includes(step.status)).length, result: data, errorCode: data.errors?.[0]?.code || result?.error?.code || '' }); } catch (_) {}
      if (result && typeof result === 'object') {
        if (result.data && typeof result.data === 'object') result.data.observabilityRunId = runId;
        else result.observabilityRunId = runId;
      }
      return result;
    } catch (error) {
      const finishedAt = Date.now();
      writeStructuredLog(console, 'error', 'observability.workflow_run_failed', correlation, { workspaceId, runtime: 'workflow', outcome: 'failed', durationMs: finishedAt - startedAt, errorCode: error?.code || 'WORKFLOW_RUN_FAILED' });
      try { service.recordRunFinish({ workspaceId, runId, traceId, agentId, runtime: 'workflow', goal, status: 'failed', startedAt, finishedAt, errorCode: error?.code || 'WORKFLOW_RUN_FAILED' }); } catch (_) {}
      throw error;
    }
  };
  return agent;
}

module.exports = { wrapWorkflowAgent };
