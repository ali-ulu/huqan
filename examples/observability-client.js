'use strict';

const crypto = require('node:crypto');
const { createObservabilityTelemetryClient } = require('../index');


/**
 * Adapt the canonical AgentV3 lifecycle events to the stable local telemetry
 * client. The adapter passes only bounded metadata and usage values; the
 * client hashes the goal before calling the observability service.
 */
function createAgentV3ObservabilityHooks({ service, workspaceId, agentId, runtime = 'agent-v3' } = {}) {
  const telemetry = createObservabilityTelemetryClient({ service, workspaceId, agentId, runtime });

  function runIdentity(state = {}) {
    const runId = state.observabilityRunId || state.runId || state.checkpointId || `agent-${crypto.randomUUID()}`;
    state.observabilityRunId = runId;
    const traceId = state.traceId || runId;
    state.traceId = traceId;
    return { runId, traceId };
  }

  return Object.freeze({
    telemetry,
    beforeAgentRun(state = {}) {
      return telemetry.startRun({
        ...runIdentity(state),
        goal: state.goal,
        objective: state.objective,
        startedAt: state.startedAt ? Date.parse(state.startedAt) : undefined,
      });
    },
    afterTask({ state = {}, step = {} } = {}) {
      return telemetry.recordStep({
        ...runIdentity(state),
        traceId: step.traceId || state.traceId,
        status: step.status,
        tool: step.tool,
        usage: step.result?.usage,
        payload: {
          stepId: step.id || null,
          action: step.action || null,
          policyAction: step.policy?.action || null,
        },
      });
    },
    afterAgentRun(state = {}) {
      const steps = Array.isArray(state.steps) ? state.steps : [];
      return telemetry.finishRun({
        ...runIdentity(state),
        status: state.status || 'completed',
        stepCount: steps.length,
        successfulSteps: steps.filter(step => ['done', 'completed'].includes(String(step.status))).length,
        blockedSteps: steps.filter(step => String(step.status) === 'blocked').length,
        errorSteps: steps.filter(step => ['error', 'failed', 'review'].includes(String(step.status))).length,
        errorCode: state.error?.code || state.blockReason,
      });
    },
  });
}

module.exports = { createAgentV3ObservabilityHooks };
