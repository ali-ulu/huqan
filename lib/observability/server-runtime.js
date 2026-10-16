'use strict';

const { createObservabilityService } = require('./service');
const { createObservabilityHealth } = require('./health');
const { createObservabilityHttpRouter } = require('./http-router');
const { createAgentWorker } = require('./agent-worker');
const { createObservabilityAuthorizer } = require('./authorization');
const { writeStructuredLog } = require('../http/structured-log');
const { wrapWorkflowAgent } = require('./workflow-agent-instrumentation');

const OPTIONAL_CONFIG_SUFFIXES = new Set([
  'AGENT_WORKER_ENABLED',
  'AGENT_WORKER_INTERVAL_MS',
  'AGENT_WORKER_LEASE_MS',
  'OBSERVABILITY_COST_PER_1K_TOKENS_MICROS',
  'OBSERVABILITY_AUTHZ_POLICY',
]);

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

  // Bounded, non-secret readiness signal for the Command Center (#1825): the
  // browser must learn whether this deployment configured the observability
  // authorization policy instead of rendering the dashboard as usable until a
  // request fails. One boolean, no policy content, no membership data.
  function getAuthorizationReadiness() {
    try {
      return { configured: Boolean(String(readConfig('OBSERVABILITY_AUTHZ_POLICY') || '').trim()) };
    } catch (_) {
      return { configured: false };
    }
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
    getAuthorizationReadiness,
    handleRoute,
    startWorkerIfEnabled,
    stop,
  };
}

module.exports = { createObservabilityServerRuntime };
