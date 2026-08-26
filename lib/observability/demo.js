'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../../kernel');
const KernelV2 = require('../../kernel.v2');
const AgentV3 = require('../../agent.v3');
const { createObservabilityService } = require('./service');

const DEMO_WORKSPACE_PREFIX = 'observability-demo';
const DEMO_GOAL = 'kedi hayvandir mi?';
const DEMO_AGENT_ID = 'agent-v3-demo';
const DEMO_HOST = '127.0.0.1';
const DEMO_PORT = 0;

function instrumentUsage(kernel) {
  for (const method of ['ask', 'verify', 'dream']) {
    if (typeof kernel[method] !== 'function') continue;
    const original = kernel[method].bind(kernel);
    kernel[method] = (...args) => {
      const result = original(...args);
      if (!result || typeof result !== 'object') return result;
      result.meta = { ...(result.meta || {}), usage: {
        tokens: 12, inputTokens: 8, outputTokens: 4, costMicros: 24, model: 'fixture-local',
      } };
      return result;
    };
  }
}

function ensureSafeRoot(rootDir) {
  const resolved = path.resolve(String(rootDir || ''));
  if (!resolved || resolved === path.parse(resolved).root || resolved.length < 12) {
    throw new Error('demo rootDir must be a dedicated non-root directory');
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function newDemoRoot(tmpdir = os.tmpdir()) {
  return fs.mkdtempSync(path.join(tmpdir, 'huqan-observability-demo-'));
}

function newDemoWorkspace() {
  return `${DEMO_WORKSPACE_PREFIX}-${crypto.randomBytes(6).toString('hex')}`;
}

function seedObservabilityDemo({ rootDir = newDemoRoot(), workspaceId = newDemoWorkspace() } = {}) {
  const root = ensureSafeRoot(rootDir);
  const workspace = String(workspaceId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspace)) {
    throw new Error('workspaceId must be one safe path-compatible identifier');
  }

  const memoryPath = path.join(root, 'memory.json');
  // server.js reopens its shared HuqanStorage from memoryPath + ".db";
  // use that canonical derived path so dashboard reads the seeded records.
  const dbPath = path.join(root, 'memory.db');
  const apiKey = crypto.randomBytes(18).toString('base64url');
  const demoSession = crypto.randomBytes(32).toString('base64url');
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath,
  });
  let agent = null;
  let service = null;
  try {
    kernel.learn('kedi hayvandir', Kernel.createAdmissionBypassOpts('observability_demo_seed'));
    instrumentUsage(kernel);
    agent = new AgentV3({
      kernel,
      dbPath,
      maxSteps: 1,
      maxIterations: 20,
      timeBudgetMs: 5000,
    });
    service = createObservabilityService({ db: agent.storage.db });
    kernel.observability = service;

    const result = agent.run(DEMO_GOAL, {
      resume: false,
      maxSteps: 1,
      maxIterations: 20,
      timeBudgetMs: 5000,
      workspaceId: workspace,
      agentId: DEMO_AGENT_ID,
      traceId: 'trace-observability-demo',
    });
    const runId = result?.data?.observabilityRunId
      || service.listRuns({ workspaceId: workspace, limit: 1 }).items[0]?.runId;
    const traceId = result?.data?.traceId
      || service.listRuns({ workspaceId: workspace, limit: 1 }).items[0]?.traceId;
    if (!runId || !traceId) throw new Error('observability demo AgentV3 run did not produce run/trace identity');

    service.recordGateDecision({
      workspaceId: workspace,
      runId,
      traceId,
      gate: 'demo-fixture-gate',
      decision: 'allow',
      payload: { fixture: 'agent-v3-local-demo' },
    });
    const queueJob = service.enqueueJob({
      workspaceId: workspace,
      goal: 'private demo queue input',
      maxSteps: 1,
    });
    kernel.graph.save();

    const events = service.listEvents({ workspaceId: workspace, runId, limit: 100 }).items;
    const runs = service.listRuns({ workspaceId: workspace, limit: 20 }).items;
    const metrics = service.summary({ workspaceId: workspace, windowMs: 86_400_000 });
    const queue = service.queueSummary({ workspaceId: workspace });
    const eventTypes = [...new Set(events.map(event => event.eventType))].sort();
    const requiredEventTypes = ['run_started', 'step_finished', 'gate_decision', 'run_finished'];
    const idsMatch = events
      .filter(event => event.runId === runId)
      .every(event => event.workspaceId === workspace
        && event.runId === runId
        && event.traceId === traceId);
    const complete = requiredEventTypes.every(type => eventTypes.includes(type)) && idsMatch;
    if (!complete) throw new Error(`observability demo event contract incomplete: ${eventTypes.join(', ')}`);

    return {
      rootDir: root,
      memoryPath,
      dbPath,
      apiKey,
      demoSession,
      workspaceId: workspace,
      runId,
      traceId,
      agentId: DEMO_AGENT_ID,
      goal: DEMO_GOAL,
      eventTypes,
      requiredEventTypes,
      metrics,
      queue,
      queueJobId: queueJob?.jobId || null,
      runCount: runs.length,
      dashboardReady: true,
    };
  } finally {
    try { agent?.storage?.close?.(); } catch (_) {}
    try { kernel.graph?.close?.(); } catch (_) {}
  }
}

function demoEnvironment(seed, { host = DEMO_HOST, port = DEMO_PORT } = {}) {
  return {
    HUQAN_API_KEY: seed.apiKey,
    HUQAN_OBSERVABILITY_DEMO_SESSION: seed.demoSession,
    HUQAN_DB_PATH: seed.dbPath,
    HUQAN_MEMORY_PATH: seed.memoryPath,
    HUQAN_USE_SQLITE: 'true',
    HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: '0',
    HUQAN_HOST: host,
    HUQAN_OBSERVABILITY_AUTHZ_POLICY: JSON.stringify({ memberships: [
      { subject: 'local-api-key', workspaceId: seed.workspaceId, role: 'viewer' },
    ] }),
    HUQAN_AGENT_WORKER_ENABLED: '0',
    PORT: String(port),
  };
}

function removeDemoRoot(rootDir) {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return !fs.existsSync(rootDir);
  } catch (_) {
    return false;
  }
}

module.exports = {
  DEMO_AGENT_ID,
  DEMO_GOAL,
  DEMO_HOST,
  DEMO_PORT,
  DEMO_WORKSPACE_PREFIX,
  newDemoWorkspace,
  demoEnvironment,
  newDemoRoot,
  removeDemoRoot,
  seedObservabilityDemo,
};
