'use strict';

const { legacyAliasUsage } = require('../legacy-alias-usage');

function createRuntimeStatusHandlers({ kernel, pkg, kernelVersion, agentVersion, agentRuntimeMode, phases, observabilityReadiness } = {}) {
  if (!kernel || !pkg || !kernelVersion || !agentVersion || !Array.isArray(phases)) {
    throw new TypeError('runtime status dependencies are required');
  }

  function getHealthData() {
    const stats = kernel.graph.getStats();
    return {
      ok: true,
      service: 'huqan',
      legacyService: 'axiom',
      kernelVersion,
      backend: stats.backend,
      nodes: stats.nodes,
      edges: stats.edges,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  function getV2StatusData() {
    const stats = kernel.graph.getStats();
    const counts = phases.reduce((acc, phase) => {
      acc.total += 1;
      acc[phase.status] += 1;
      return acc;
    }, { total: 0, done: 0, in_progress: 0, pending: 0 });
    const progressPercent = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
    return {
      ok: true,
      version: pkg.version,
      contractVersion: kernel.contractVersion || '1.0.0',
      activeKernel: kernelVersion,
      backend: stats.backend,
      nodes: stats.nodes,
      edges: stats.edges,
      updatedAt: new Date().toISOString(),
      counts,
      progressPercent,
      remainingPhases: Math.max(0, counts.total - counts.done),
      phases,
      currentFocus: 'v3.0 Agent Workflow',
      nextAction: 'Use the planner to run goal-driven multi-step tasks, persist the goal history, and report each tool decision clearly.',
      agentRuntime: agentVersion,
      agentRuntimeMode,
      checkpointBackend: agentVersion === 'v3' ? 'sqlite' : 'json',
      // RFC-001's compatibility window has no end criterion without a number:
      // "is alias use going down?" cannot be answered by a deprecation nobody
      // counts, so removal never becomes evidently safe and the window becomes
      // permanent by default. Process-local, since the last restart.
      legacyAliasUsage: legacyAliasUsage(),
      // Issue #1825: the Command Center learns whether observability is usable
      // on this deployment from the runtime itself — a single boolean, no
      // policy content — instead of duplicating environment assumptions in
      // browser code. `configured: null` means the runtime did not wire the
      // signal, so the UI must not claim either state.
      observability: typeof observabilityReadiness === 'function'
        ? observabilityReadiness()
        : { configured: null },
    };
  }

  return { getHealthData, getV2StatusData };
}

module.exports = { createRuntimeStatusHandlers };
