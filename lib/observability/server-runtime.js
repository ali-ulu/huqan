'use strict';

const crypto = require('node:crypto');
const { createObservabilityService } = require('./service');
const { createObservabilityHealth } = require('./health');
const { createObservabilityHttpRouter } = require('./http-router');
const { createAgentWorker } = require('./agent-worker');
const { createObservabilityAuthorizer } = require('./authorization');
const { writeStructuredLog } = require('../http/structured-log');

const OPTIONAL_CONFIG_SUFFIXES = new Set([
  'AGENT_WORKER_ENABLED',
  'AGENT_WORKER_INTERVAL_MS',
  'AGENT_WORKER_LEASE_MS',
  'OBSERVABILITY_COST_PER_1K_TOKENS_MICROS',
  'OBSERVABILITY_AUTHZ_POLICY',
]);

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
    writeStructuredLog(console, 'info', 'observability.workflow_run_started', correlation, {
      workspaceId, runtime: 'workflow', outcome: 'started',
    });
    try { service.recordRunStart({ workspaceId, runId, traceId, agentId, runtime: 'workflow', goal, startedAt }); } catch (_) {}
    try {
      const result = await originalRun(goal, runOptions);
      const data = result?.data || result || {};
      const steps = Array.isArray(data.steps) ? data.steps : [];
      for (const step of steps) {
        try { service.recordStep({ workspaceId, runId, traceId: step.traceId || traceId, agentId, status: step.status, tool: step.tool, result: step.output, payload: { stepId: step.id, phase: 'workflow' } }); } catch (_) {}
      }
      const finishedAt = Date.now();
      writeStructuredLog(console, 'info', 'observability.workflow_run_finished', correlation, {
        workspaceId, runtime: 'workflow', outcome: data.status || (result?.ok ? 'completed' : 'failed'), durationMs: finishedAt - startedAt,
      });
      try {
        service.recordRunFinish({
          workspaceId, runId, traceId, agentId, runtime: 'workflow', goal,
          objective: data.objective,
          status: data.status || (result?.ok ? 'completed' : 'failed'),
          startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt),
          stepCount: steps.length,
          successfulSteps: steps.filter(step => step.status === 'done').length,
          blockedSteps: steps.filter(step => step.status === 'blocked').length,
          errorSteps: steps.filter(step => ['error', 'review'].includes(step.status)).length,
          result: data,
          errorCode: data.errors?.[0]?.code || result?.error?.code || '',
        });
      } catch (_) {}
      if (result && typeof result === 'object') {
        if (result.data && typeof result.data === 'object') result.data.observabilityRunId = runId;
        else result.observabilityRunId = runId;
      }
      return result;
    } catch (error) {
      const finishedAt = Date.now();
      writeStructuredLog(console, 'error', 'observability.workflow_run_failed', correlation, {
        workspaceId, runtime: 'workflow', outcome: 'failed', durationMs: finishedAt - startedAt, errorCode: error?.code || 'WORKFLOW_RUN_FAILED',
      });
      try { service.recordRunFinish({ workspaceId, runId, traceId, agentId, runtime: 'workflow', goal, status: 'failed', startedAt, finishedAt, errorCode: error?.code || 'WORKFLOW_RUN_FAILED' }); } catch (_) {}
      throw error;
    }
  };
  return agent;
}

function createObservabilityServerRuntime({
  kernel,
  getStorage,
  createAgent,
  parseJsonRequest,
  writeJson,
  denyIfUnauthorized,
  readEnvironment,
} = {}) {
  if (typeof getStorage !== 'function' || typeof createAgent !== 'function' || typeof readEnvironment !== 'function') {
    throw new TypeError('observability server runtime dependencies are required');
  }

  let service = null;
  let worker = null;
  let health = null;
  let authorizer = null;

  function readConfig(suffix) {
    try {
      return readEnvironment(suffix);
    } catch (error) {
      if (!OPTIONAL_CONFIG_SUFFIXES.has(suffix)) throw error;
      const canonical = process.env[`HUQAN_${suffix}`];
      const legacy = process.env[`AXIOM_${suffix}`];
      if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
        const conflict = new Error(`conflicting environment variables: HUQAN_${suffix} and AXIOM_${suffix}`);
        conflict.code = 'HUQAN_ENV_CONFLICT';
        throw conflict;
      }
      return canonical !== undefined ? canonical : legacy;
    }
  }

  function getService() {
    if (service) return service;
    const storage = getStorage();
    service = createObservabilityService({
      db: storage.db,
      costPer1kTokensMicros: Number(readConfig('OBSERVABILITY_COST_PER_1K_TOKENS_MICROS')) || null,
    });
    if (kernel) kernel.observability = service;
    return service;
  }

  function getHealth() {
    if (health) return health;
    health = createObservabilityHealth({
      getDb: () => getStorage().db,
      getWorkerState: () => ({
        enabled: readConfig('AGENT_WORKER_ENABLED') === '1',
        running: Boolean(worker),
        busy: Boolean(worker?.busy),
      }),
    });
    return health;
  }

  function createObservedAgent(options = {}) {
    const agent = createAgent({
      kernel,
      observability: getService(),
      version: readConfig('AGENT_VERSION'),
      ...options,
    });
    return wrapWorkflowAgent(agent, getService(), options);
  }

  function authorizeWorkspace(input) {
    authorizer ||= createObservabilityAuthorizer({ policy: readConfig('OBSERVABILITY_AUTHZ_POLICY') });
    return authorizer.authorize(input);
  }

  const handleRoute = createObservabilityHttpRouter({
    getService,
    getHealth,
    parseJsonRequest,
    writeJson,
    denyIfUnauthorized,
    authorizeWorkspace,
  });

  function startWorkerIfEnabled() {
    if (readConfig('AGENT_WORKER_ENABLED') !== '1') return false;
    try {
      const observedService = getService();
      worker = createAgentWorker({
        service: observedService,
        createAgent: createObservedAgent,
        intervalMs: Number(readConfig('AGENT_WORKER_INTERVAL_MS')) || 1000,
        leaseMs: Number(readConfig('AGENT_WORKER_LEASE_MS')) || 120000,
      });
      worker.start();
      return true;
    } catch (error) {
      writeStructuredLog(console, 'error', 'observability.agent_worker_disabled', {}, { runtime: 'observability', errorCode: error?.code || 'AGENT_WORKER_DISABLED' });
      worker = null;
      return false;
    }
  }

  function stop() {
    worker?.stop?.();
    worker = null;
  }

  return {
    createAgent: createObservedAgent,
    getService,
    getHealth,
    handleRoute,
    startWorkerIfEnabled,
    stop,
  };
}

module.exports = { createObservabilityServerRuntime };
