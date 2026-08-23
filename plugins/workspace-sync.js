'use strict';

/**
 * workspace-sync (#213).
 *
 * #213 asks for an afterAgentRun hook doing "workspace'ler arası referans
 * senkronu (AB11 ile birlikte)" -- cross-workspace reference sync, together
 * with AB11. Two things had to be checked before this could be designed,
 * not assumed:
 *
 * 1. afterAgentRun only fires from agent.js (confirmed for #212's
 *    daily-digest.js: agentRuntime.js's createAgent() defaults to agent.js,
 *    and agent.v3.js never emits afterAgentRun at all).
 * 2. Per-run workspace scoping (_withWorkspaceScope, "the run-level
 *    workspace is authoritative") is an agent.v3.js-only concept -- grep
 *    confirms agent.js has zero references to `workspaceId` anywhere.
 *
 * So the one reliable afterAgentRun source has no workspace concept, and
 * the implementation that has one doesn't emit the hook. There is no
 * `state.workspaceId` to read.
 *
 * What this plugin does instead: reads whatever workspaceId a step's tool
 * options actually carried (callers CAN pass one even though agent.js
 * doesn't specially scope it), and tracks, per agent goal, which
 * workspace(s) that goal has been run under over time. When the same goal
 * reappears under a *different* workspace than its last recorded run, that
 * is a genuine cross-workspace reference -- exactly AB11's question ("an
 * actor in workspace A reaching into workspace B") applied to goal history
 * instead of a single MCP call. So the decision is made by calling AB11's
 * own evaluateCrossWorkspaceAccess() directly ("AB11 ile birlikte") rather
 * than reimplementing workspace-isolation policy, and reported through
 * #212's afterGateDecision telemetry the same way the other three gate
 * call sites are.
 */

const { evaluateCrossWorkspaceAccess } = require('../lib/cross-workspace-access-gate');
const { emitGateTelemetry } = require('../lib/gate-telemetry');

const DEFAULT_WORKSPACE_ID = 'default';

// #1309: syncState.log is in-memory for the kernel's lifetime with no other
// pruning, so on a long-lived kernel it would otherwise grow without bound.
// Cap it as a ring buffer -- drop the oldest entry once the cap is reached.
const MAX_LOG_ENTRIES = 500;

function ensureSyncState(kernel) {
  if (!kernel._workspaceSyncState) {
    kernel._workspaceSyncState = { byGoal: {}, log: [] };
  }
  return kernel._workspaceSyncState;
}

/**
 * agent.js now stamps state.workspaceId from run(goal, opts)'s opts.workspaceId
 * (added alongside this plugin, since agent.js previously had no workspace
 * concept anywhere -- see agent.js's run() for the actual stamping). Falls
 * back to 'default', the same fallback graph.js itself uses when nothing is
 * specified.
 */
function resolveRunWorkspaceId(state) {
  const workspaceId = state && state.workspaceId;
  if (typeof workspaceId === 'string' && workspaceId.trim()) return workspaceId.trim();
  return DEFAULT_WORKSPACE_ID;
}

function recordRun(kernel, state) {
  const syncState = ensureSyncState(kernel);
  const goal = String((state && state.goal) || '').trim();
  if (!goal) return null;

  const workspaceId = resolveRunWorkspaceId(state);
  const previous = syncState.byGoal[goal];
  const entry = { goal, workspaceId, runAt: new Date().toISOString() };

  let crossWorkspaceDecision = null;
  if (previous && previous.workspaceId !== workspaceId) {
    crossWorkspaceDecision = evaluateCrossWorkspaceAccess({
      actorWorkspaceId: previous.workspaceId,
      targetWorkspaceId: workspaceId,
      operation: 'read',
      resourceType: 'agent-goal',
    });
    emitGateTelemetry(kernel, 'workspace-sync', crossWorkspaceDecision);
    syncState.log.push({
      goal,
      fromWorkspaceId: previous.workspaceId,
      toWorkspaceId: workspaceId,
      decision: crossWorkspaceDecision.decision,
      reason: crossWorkspaceDecision.reason,
      at: entry.runAt,
    });
    if (syncState.log.length > MAX_LOG_ENTRIES) {
      syncState.log.splice(0, syncState.log.length - MAX_LOG_ENTRIES);
    }
  }

  syncState.byGoal[goal] = entry;
  return crossWorkspaceDecision;
}

module.exports = {
  name: 'workspace-sync',
  requires: [],
  optional: [],
  capabilities: [
    {
      name: 'workspaceSync',
      command: 'workspace-sync',
      description: 'Tracks which workspace each agent goal was last run under and flags cross-workspace reruns via AB11.',
    },
  ],

  afterAgentRun(kernel, state) {
    recordRun(kernel, state);
  },

  run(kernel, input = {}) {
    const action = String(input.action || 'log').toLowerCase();
    const syncState = ensureSyncState(kernel);
    if (action === 'log') {
      return { ok: true, log: [...syncState.log] };
    }
    if (action === 'bygoal') {
      return { ok: true, byGoal: { ...syncState.byGoal } };
    }
    return { ok: false, error: `Unsupported workspace-sync action: ${action}` };
  },
};

module.exports._test = { ensureSyncState, resolveRunWorkspaceId, recordRun, DEFAULT_WORKSPACE_ID, MAX_LOG_ENTRIES };
