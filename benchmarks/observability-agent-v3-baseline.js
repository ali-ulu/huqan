'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AgentV3 = require('../agent.v3');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { createObservabilityService } = require('../lib/observability/service');

const DEFAULT_TARGETS = require('./fixtures/observability-agent-v3-targets.json');
const FIXTURE_GOAL = 'kedi hayvandir mi?';

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

function assertTargets(report, targets) {
  const failures = [];
  if (report.metrics.successRate < targets.minSuccessRate) failures.push('successRate');
  if (report.metrics.avgLatencyMs > targets.maxAverageLatencyMs) failures.push('avgLatencyMs');
  if (report.metrics.p95LatencyMs > targets.maxP95LatencyMs) failures.push('p95LatencyMs');
  if (report.queue.lagMs > targets.maxQueueLagMs) failures.push('queueLagMs');
  if (!report.metrics.tokenKnown) failures.push('tokenKnown');
  if (!report.metrics.costKnown) failures.push('costKnown');
  if (report.eventCompleteness !== 1) failures.push('eventCompleteness');
  if (failures.length) throw new Error(`OBSERVABILITY_BASELINE_TARGET_FAILED: ${failures.join(', ')}`);
}

function runBaseline({ targets = DEFAULT_TARGETS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-observability-baseline-'));
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(root, 'memory.json'),
  });
  kernel.learn('kedi hayvandir', Kernel.createAdmissionBypassOpts('test_fixture_seed'));
  instrumentUsage(kernel);
  const agent = new AgentV3({
    kernel,
    dbPath: path.join(root, 'agent.db'),
    maxSteps: 1,
    maxIterations: 20,
    timeBudgetMs: 5000,
  });
  const service = createObservabilityService({ db: agent.storage.db });
  kernel.observability = service;
  const workspaceId = 'observability-baseline';
  const runs = [];
  try {
    for (let index = 0; index < targets.runs; index += 1) {
      const result = agent.run(FIXTURE_GOAL, {
        resume: false, maxSteps: 1, maxIterations: 20, timeBudgetMs: 5000, workspaceId,
      });
      if (!result?.data?.observabilityRunId) {
        const latest = service.listRuns({ workspaceId, limit: 1 }).items[0];
        result.data.observabilityRunId = latest?.runId;
      }
      const runId = result.data.observabilityRunId;
      service.recordGateDecision({
        workspaceId, runId, traceId: runId, gate: 'baseline-fixture', decision: 'allow',
        payload: { fixture: true },
      });
      const events = service.listEvents({ workspaceId, runId, limit: 100 }).items;
      const types = new Set(events.map(event => event.eventType));
      const required = ['run_started', 'step_finished', 'gate_decision', 'run_finished'];
      const idsMatch = events.every(event => event.workspaceId === workspaceId
        && event.runId === runId && event.traceId === runId);
      runs.push({ runId, complete: required.every(type => types.has(type)) && idsMatch });
    }
    service.enqueueJob({ workspaceId, goal: 'private baseline queue input', maxSteps: 1 });
    const report = {
      schemaVersion: 1,
      fixture: { name: 'agent-v3-local-deterministic', runCount: targets.runs },
      metrics: service.summary({ workspaceId, windowMs: 60_000 }),
      queue: service.queueSummary({ workspaceId }),
      eventCompleteness: runs.filter(run => run.complete).length / runs.length,
      runs,
      targets,
    };
    assertTargets(report, targets);
    return report;
  } finally {
    try { agent.storage.close(); } catch (_) {}
    try { kernel.graph?.close?.(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(runBaseline(), null, 2)}\n`);
}

module.exports = { assertTargets, runBaseline };
