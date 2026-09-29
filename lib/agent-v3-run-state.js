'use strict';

const crypto = require('node:crypto');
const { ensureState } = require('./agent-v3-dream-loop-adapter');

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * The run state a checkpoint carries. `saveRunCheckpoint` hands storage a
 * record with the run state under `state`, and HuqanStorage keeps that whole
 * record in `state_json`, so a loaded checkpoint holds the run state one level
 * down (`checkpoint.state.state`). Reading `checkpoint.state` itself resumed
 * from the record's bookkeeping fields: no steps, no queue, and a new run
 * identity on every resume. A store that returns the run state directly (the
 * shape the resume contract tests inject) is still accepted.
 */
function savedRunState(checkpoint) {
  const record = checkpoint && checkpoint.state;
  if (!record || typeof record !== 'object') return null;
  const nested = record.state;
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : record;
}

/** Build the mutable run state for a v3 run, either resuming from a durable
 * checkpoint or starting fresh from the plan. Pure: it reads the plan and the
 * checkpoint record and returns a new object without touching storage. */
function hydrateRunState(activePlan, checkpoint = null, { timeBudgetMs } = {}) {
  const saved = savedRunState(checkpoint);
  if (saved) {
    const state = cloneValue(saved);
    state.plan = state.plan || cloneValue(activePlan);
    state.goal = state.goal || activePlan.goal;
    state.objective = state.objective || activePlan.objective;
    state.selectedTools = Array.isArray(state.selectedTools) ? state.selectedTools : [...(activePlan.selectedTools || [])];
    state.steps = Array.isArray(state.steps) ? state.steps : [];
    state.evidence = Array.isArray(state.evidence) ? state.evidence : [];
    state.notes = Array.isArray(state.notes) ? state.notes : [];
    // An empty queue is a run with nothing left to do (it stopped in
    // finalization), not a missing one: refilling it from the plan would run
    // every completed step again. Only a checkpoint with no queue at all
    // falls back to the plan.
    state.queuedSteps = Array.isArray(state.queuedSteps)
      ? state.queuedSteps
      : cloneValue(activePlan.steps || []);
    state.resumed = true;
    state.resumedFrom = checkpoint.id;
    state.resumeToken = checkpoint.id;
    state.checkpointId = checkpoint.id;
    state.status = 'running';
    state.progress = state.progress || { stalledCount: 0, lastSummary: '' };
    if (state.dreamExperimentLoop && typeof state.dreamExperimentLoop === 'object') {
      state.dreamExperimentLoop = ensureState(state.dreamExperimentLoop, {
        workspaceId: state.workspaceId,
        goal: state.goal,
        checkpointId: state.checkpointId,
      });
    }
    state.completedSteps = Number(state.steps.length || 0);
    state.remainingSteps = Array.isArray(state.queuedSteps) ? state.queuedSteps.length : 0;
    state.iteration = Number(state.iteration || state.steps.length || 0);
    // Remember where this run() picked up, so the durable run row can record
    // what this call actually spent rather than the whole running total.
    state.iterationsAtRunStart = state.iteration;
    state.budgetRemaining = Number(checkpoint.budget_remaining || timeBudgetMs);
    state.startedAt = state.startedAt || nowIso();
    return state;
  }

  return {
    goal: activePlan.goal,
    objective: activePlan.objective,
    selectedTools: [...(activePlan.selectedTools || [])],
    plan: cloneValue(activePlan),
    steps: [],
    evidence: [],
    status: 'running',
    notes: [],
    queuedSteps: cloneValue(activePlan.steps || []),
    resumed: false,
    resumedFrom: null,
    resumeToken: null,
    checkpointId: null,
    startedAt: nowIso(),
    progress: { stalledCount: 0, lastSummary: '' },
    completedSteps: 0,
    remainingSteps: Array.isArray(activePlan.steps) ? activePlan.steps.length : 0,
    iteration: 0, iterationsAtRunStart: 0, budgetRemaining: timeBudgetMs,
    dreamExperimentLoop: null, planSupersededByLoop: false,
  };
}

/** Persist the run checkpoint and return its id. Owns the id/workspace
 * bookkeeping the storage layer expects; the caller owns the run loop. */
function saveRunCheckpoint(state, { storage }) {
  const checkpointId = state.checkpointId || state.resumeToken || `checkpoint-${crypto.randomUUID?.() || Date.now()}`;
  state.checkpointId = checkpointId;
  state.resumeToken = checkpointId;
  state.budgetRemaining = Math.max(0, Number(state.budgetRemaining || 0));
  storage.saveCheckpoint({
    checkpointId,
    id: checkpointId,
    goal: state.goal,
    iteration: Number(state.iteration || 0),
    budgetRemaining: state.budgetRemaining,
    lastAction: state.lastAction || '',
    evidence: state.evidence || [],
    status: state.status || 'running',
    // Must be carried explicitly: storage reads the workspace off this
    // object, not off the nested `state`, so omitting it would file every
    // checkpoint under 'default' and make workspace-scoped resume never
    // find anything.
    workspaceId: state.workspaceId,
    startedAtMs: Date.parse(state.startedAt || nowIso()) || Date.now(),
    state,
  });
  return checkpointId;
}

module.exports = { cloneValue, hydrateRunState, saveRunCheckpoint };
