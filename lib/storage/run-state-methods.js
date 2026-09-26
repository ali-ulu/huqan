// HuqanStorage's checkpoint, goal-memory and run records, moved out of
// storage.js (#2165). storage.js installs these on HuqanStorage.prototype as
// ordinary non-enumerable methods, the descriptor they had as class methods;
// `this` is the storage instance (its _stmts, _now and _newId).

const { normalizeWorkspaceId } = require('../workspace-id');
const { goalMemoryKey, lower, normalizeGoal, resolveIterationsDelta, safeParse } = require('./run-state-keys');

class RunStateMethods {
  saveCheckpoint(state = {}) {
    const id = String(state.checkpointId || state.id || this._newId('checkpoint'));
    const goal = normalizeGoal(state.goal);
    const payload = {
      id,
      goal_key: lower(goal),
      goal,
      state_json: JSON.stringify(state),
      iteration: Number(state.iteration || 0),
      budget_remaining: Number(state.budgetRemaining || 0),
      last_action: String(state.lastAction || ''),
      evidence_json: JSON.stringify(Array.isArray(state.evidence) ? state.evidence : []),
      status: String(state.status || 'running'),
      workspace_id: normalizeWorkspaceId(state.workspaceId),
      created_at: Number(state.startedAtMs || this._now()),
      updated_at: this._now(),
    };
    this._stmts.upsertCheckpoint.run(payload);
    return id;
  }

  /**
   * Checkpoints are workspace-scoped: a goal paused in one workspace must not
   * be resumable from another, or the resuming run inherits that workspace's
   * queued steps, evidence and progress. Callers that omit `workspaceId` get
   * the 'default' workspace, which is where rows written before this column
   * existed were implicitly stored.
   */
  loadLatestCheckpoint(goal, workspaceId) {
    const row = this._stmts.getLatestCheckpoint.get(lower(goal), normalizeWorkspaceId(workspaceId));
    if (!row) return null;
    return {
      ...row,
      evidence: safeParse(row.evidence_json, []),
      state: safeParse(row.state_json, null),
    };
  }

  // Named checkpoint lookup for explicit continuation requests. Scopes the
  // id to goal + workspace so a named checkpoint from another scope cannot
  // hydrate this run; completed rows stay invisible. `loadLatestCheckpoint`
  // remains the default when no id is named.
  loadCheckpoint(id, goal, workspaceId) {
    const row = this._stmts.getCheckpointById.get(
      String(id), lower(goal), normalizeWorkspaceId(workspaceId),
    );
    if (!row) return null;
    return {
      ...row,
      evidence: safeParse(row.evidence_json, []),
      state: safeParse(row.state_json, null),
    };
  }

  deleteCheckpoint(id, goal, workspaceId) {
    if (!id || !normalizeGoal(goal) || workspaceId === undefined || workspaceId === null || !String(workspaceId).trim()) return false;
    const info = this._stmts.deleteCheckpoint.run(
      String(id), lower(goal), normalizeWorkspaceId(workspaceId),
    );
    return info.changes > 0;
  }

  saveGoalMemory(record = {}) {
    const goal = normalizeGoal(record.goal);
    const workspaceId = normalizeWorkspaceId(record.workspaceId);
    const key = goalMemoryKey(goal, workspaceId);
    const current = this.getGoalMemory(goal, workspaceId) || {
      key,
      workspace_id: workspaceId,
      goal,
      objective: record.objective || 'investigate',
      success_count: 0,
      blocked_count: 0,
      error_count: 0,
      resumed_count: 0,
      last_status: 'unknown',
      pattern_json: '{}',
      created_at: this._now(),
      updated_at: this._now(),
    };

    const status = String(record.status || 'unknown');
    const next = {
      key,
      workspace_id: workspaceId,
      goal,
      objective: record.objective || current.objective || 'investigate',
      success_count: Number(current.success_count || 0) + (status === 'completed' ? 1 : 0),
      blocked_count: Number(current.blocked_count || 0) + (status === 'blocked' ? 1 : 0),
      error_count: Number(current.error_count || 0) + (status === 'error' ? 1 : 0),
      resumed_count: Number(current.resumed_count || 0) + (record.resumed ? 1 : 0),
      last_status: status,
      pattern_json: JSON.stringify({
        lastFinalAnswer: record.finalAnswer || '',
        lastSelectedTools: Array.isArray(record.selectedTools) ? [...record.selectedTools] : [],
        lastIterations: Number(record.completedSteps || 0),
        lastStatus: status,
        resumed: Boolean(record.resumed),
      }),
      created_at: Number(current.created_at || this._now()),
      updated_at: this._now(),
    };
    this._stmts.upsertGoalMemory.run(next);
    return next;
  }

  getGoalMemory(goal, workspaceId) {
    const row = this._stmts.getGoalMemory.get(goalMemoryKey(goal, workspaceId));
    if (!row) return null;
    return {
      ...row,
      pattern: safeParse(row.pattern_json, {}),
    };
  }

  saveRun(state = {}) {
    const id = String(state.memoryId || state.runId || state.id || this._newId('run'));
    const goal = normalizeGoal(state.goal);
    const payload = {
      id,
      goal_key: lower(goal),
      goal,
      objective: state.objective || 'investigate',
      status: state.status || 'running',
      report: state.report || '',
      state_json: JSON.stringify(state),
      iterations: Number(state.iteration || state.completedSteps || 0),
      iterations_delta: resolveIterationsDelta(state),
      completed_steps: Number(state.completedSteps || 0),
      budget_remaining: Number(state.budgetRemaining || 0),
      resumed: state.resumed ? 1 : 0,
      checkpoint_id: String(state.checkpointId || state.resumeToken || ''),
      workspace_id: normalizeWorkspaceId(state.workspaceId),
      created_at: Number(state.startedAtMs || this._now()),
      updated_at: this._now(),
    };
    this._stmts.upsertRun.run(payload);
    return id;
  }

  /** AB10: cumulative iterations already spent by `workspaceId` since `sinceMs`. */
  sumAgentIterationsSince(workspaceId, sinceMs) {
    const row = this._stmts.sumAgentIterationsSince.get(String(workspaceId || 'default'), Number(sinceMs) || 0);
    return Number(row?.total || 0);
  }

  countRuns() {
    return Number(this._stmts.countRuns.get()?.c || 0);
  }

  countGoals(workspaceId) {
    if (workspaceId === undefined) return Number(this._stmts.countGoals.get()?.c || 0);
    return Number(this._stmts.countGoalsForWorkspace.get(normalizeWorkspaceId(workspaceId))?.c || 0);
  }

  countCheckpoints() {
    return Number(this._stmts.countCheckpoints.get()?.c || 0);
  }
}

module.exports = Object.freeze(Object.fromEntries(
  Object.getOwnPropertyNames(RunStateMethods.prototype)
    .filter(name => name !== 'constructor')
    .map(name => [name, RunStateMethods.prototype[name]]),
));
