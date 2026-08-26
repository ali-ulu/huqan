const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { resolveContainedPath } = require('./lib/memory-store-utils');
const { applyStorageSchema } = require('./lib/storage/schema');
const { loadSqliteDriver, sqliteUnavailableError } = require('./lib/sqlite-availability');
const { normalizeWorkspaceId } = require('./lib/workspace-id');
const toolApprovalMethods = require('./lib/storage/tool-approval-methods');
const { resolveDefaultMemoryPath } = require('./lib/default-persistence-path');

// The load error is retained (not discarded as before) so the throw site can
// tell "not installed" from "installed but built for a different Node ABI" —
// two failures with different fixes that used to look identical to the user.
const { Database, loadError: sqliteLoadError } = loadSqliteDriver();

// Rows pulled per keyset page when recovering expired execution leases (#426).
const RECOVERY_PAGE_SIZE = 500;

function normalizeGoal(goal) {
  return String(goal || '').trim();
}

function lower(goal) {
  return normalizeGoal(goal).toLowerCase();
}

const APPROVAL_KEY_SEPARATOR = '\u001f';

function approvalWorkspaceId(record = {}) {
  return normalizeWorkspaceId(
    record.workspaceId
      ?? record.context?.workspaceId
      ?? record.context?.snapshot?.workspaceId,
  );
}

function scopedApprovalKey(approvalKey, workspaceId) {
  const key = String(approvalKey || '');
  const prefix = `${workspaceId}${APPROVAL_KEY_SEPARATOR}`;
  return key.startsWith(prefix) ? key : `${prefix}${key}`;
}

/**
 * Workspace-qualified goal-memory key (#757).
 *
 * `key` is goal_memory's PRIMARY KEY and SQLite cannot alter that in place, so
 * the workspace lives inside the key rather than beside it. US (0x1f) is the
 * separator because it cannot appear in a trimmed workspace id or goal text.
 */
function goalMemoryKey(goal, workspaceId) {
  return `${normalizeWorkspaceId(workspaceId)}\u001f${lower(goal)}`;
}

/**
 * Iterations spent by *this* saveRun() call.
 *
 * `state.iteration` is cumulative across resumes, so writing it into a rolling
 * window sum counts the same iterations again on every resume. Callers that
 * track a run's starting point pass `iterationsDelta`; those that do not (a
 * direct saveRun of a one-shot run, or a test seeding usage) fall back to the
 * cumulative figure, which for a non-resumed run is the same number.
 */
function resolveIterationsDelta(state = {}) {
  const explicit = Number(state.iterationsDelta);
  if (state.iterationsDelta !== null && state.iterationsDelta !== undefined
    && state.iterationsDelta !== '' && Number.isFinite(explicit)) {
    return Math.max(0, explicit);
  }
  return Math.max(0, Number(state.iteration || state.completedSteps || 0));
}

function resolveDbPath(opts = {}, kernel) {
  // os.tmpdir() is an allowed root here for the same reason it is one in
  // lib/memory-store-utils.resolveDbPath: ephemeral stores (tests, sandboxed
  // runs) legitimately live there. resolveContainedPath still canonicalizes
  // through it, so a symlink pointing out of the temp root is still rejected.
  const allowedRoots = [process.cwd(), os.tmpdir()];
  if (typeof kernel?.graph?.memoryPath === 'string' && kernel.graph.memoryPath.trim()) {
    allowedRoots.push(path.dirname(path.resolve(kernel.graph.memoryPath.trim())));
  }
  if (typeof opts.memoryPath === 'string' && opts.memoryPath.trim()) {
    allowedRoots.push(path.dirname(path.resolve(opts.memoryPath.trim())));
  }

  if (Object.prototype.hasOwnProperty.call(opts, 'dbPath') && opts.dbPath) {
    return resolveContainedPath(opts.dbPath, allowedRoots);
  }
  const graphMemoryPath = kernel?.graph?.memoryPath;
  if (typeof graphMemoryPath === 'string' && graphMemoryPath.endsWith('.json')) {
    return resolveContainedPath(graphMemoryPath.replace(/\.json$/, '.db'), allowedRoots);
  }
  // #1579: the last of the three default-path sources (the graph's and
  // MemoryStore's are the others). Under the test runner this resolves outside
  // the repository, so a storage built with no path -- as agentRuntime.test.js
  // does through a fake kernel -- stops leaving a memory.db in the working tree.
  const fallback = path.resolve(path.dirname(resolveDefaultMemoryPath()), 'memory.db');
  allowedRoots.push(path.dirname(fallback));
  return resolveContainedPath(fallback, allowedRoots);
}

class HuqanStorage {
  constructor(opts = {}) {
    this.kernel = opts.kernel;
    this.dbPath = resolveDbPath(opts, this.kernel);
    if (!Database) {
      throw sqliteUnavailableError('better-sqlite3 is required for v3 storage.', sqliteLoadError);
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
  }

  _init() {
    applyStorageSchema(this.db);

    this._stmts = {
      upsertCheckpoint: this.db.prepare(`
        INSERT INTO checkpoints (
          id, goal_key, goal, state_json, iteration, budget_remaining,
          last_action, evidence_json, status, workspace_id, created_at, updated_at
        ) VALUES (
          @id, @goal_key, @goal, @state_json, @iteration, @budget_remaining,
          @last_action, @evidence_json, @status, @workspace_id, @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          goal_key = excluded.goal_key,
          goal = excluded.goal,
          state_json = excluded.state_json,
          iteration = excluded.iteration,
          budget_remaining = excluded.budget_remaining,
          last_action = excluded.last_action,
          evidence_json = excluded.evidence_json,
          status = excluded.status,
          workspace_id = excluded.workspace_id,
          updated_at = excluded.updated_at
      `),
      getLatestCheckpoint: this.db.prepare(`
        SELECT *
        FROM checkpoints
        WHERE goal_key = ? AND workspace_id = ? AND status != 'completed'
        ORDER BY updated_at DESC
        LIMIT 1
      `),
      getCheckpointById: this.db.prepare('SELECT * FROM checkpoints WHERE id = ? AND goal_key = ? AND workspace_id = ? AND status != \'completed\' LIMIT 1'),
      deleteCheckpoint: this.db.prepare('DELETE FROM checkpoints WHERE id = ? AND goal = ? AND workspace_id = ?'),
      upsertGoalMemory: this.db.prepare(`
        INSERT INTO goal_memory (
          key, workspace_id, goal, objective, success_count, blocked_count, error_count,
          resumed_count, last_status, pattern_json, created_at, updated_at
        ) VALUES (
          @key, @workspace_id, @goal, @objective, @success_count, @blocked_count, @error_count,
          @resumed_count, @last_status, @pattern_json, @created_at, @updated_at
        )
        ON CONFLICT(key) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          goal = excluded.goal,
          objective = excluded.objective,
          success_count = excluded.success_count,
          blocked_count = excluded.blocked_count,
          error_count = excluded.error_count,
          resumed_count = excluded.resumed_count,
          last_status = excluded.last_status,
          pattern_json = excluded.pattern_json,
          updated_at = excluded.updated_at
      `),
      getGoalMemory: this.db.prepare('SELECT * FROM goal_memory WHERE key = ? LIMIT 1'),
      countGoalsForWorkspace: this.db.prepare('SELECT COUNT(*) AS c FROM goal_memory WHERE workspace_id = ?'),
      upsertRun: this.db.prepare(`
        INSERT INTO agent_runs (
          id, goal_key, goal, objective, status, report, state_json,
          iterations, iterations_delta, completed_steps, budget_remaining, resumed, checkpoint_id,
          workspace_id, created_at, updated_at
        ) VALUES (
          @id, @goal_key, @goal, @objective, @status, @report, @state_json,
          @iterations, @iterations_delta, @completed_steps, @budget_remaining, @resumed, @checkpoint_id,
          @workspace_id, @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          goal_key = excluded.goal_key,
          goal = excluded.goal,
          objective = excluded.objective,
          status = excluded.status,
          report = excluded.report,
          state_json = excluded.state_json,
          iterations = excluded.iterations,
          iterations_delta = excluded.iterations_delta,
          completed_steps = excluded.completed_steps,
          budget_remaining = excluded.budget_remaining,
          resumed = excluded.resumed,
          checkpoint_id = excluded.checkpoint_id,
          workspace_id = excluded.workspace_id,
          updated_at = excluded.updated_at
      `),
      sumAgentIterationsSince: this.db.prepare(`
        SELECT COALESCE(SUM(iterations_delta), 0) AS total
        FROM agent_runs
        WHERE workspace_id = ? AND updated_at >= ?
      `),
      countRuns: this.db.prepare('SELECT COUNT(*) AS c FROM agent_runs'),
      countGoals: this.db.prepare('SELECT COUNT(*) AS c FROM goal_memory'),
      countCheckpoints: this.db.prepare('SELECT COUNT(*) AS c FROM checkpoints'),
      upsertToolApproval: this.db.prepare(`
        INSERT INTO tool_approvals (
          id, approval_key, tool, input, context_json, policy_json,
          status, decision, reason, workspace_id, created_at, updated_at, decided_at
        ) VALUES (
          @id, @approval_key, @tool, @input, @context_json, @policy_json,
          @status, @decision, @reason, @workspace_id, @created_at, @updated_at, @decided_at
        )
        ON CONFLICT(approval_key) DO UPDATE SET
          tool = excluded.tool,
          input = excluded.input,
          context_json = excluded.context_json,
          policy_json = excluded.policy_json,
          status = excluded.status,
          decision = excluded.decision,
          reason = excluded.reason,
          workspace_id = excluded.workspace_id,
          updated_at = excluded.updated_at,
          decided_at = excluded.decided_at
      `),
      insertToolApprovalIfAbsent: this.db.prepare(`
        INSERT INTO tool_approvals (
          id, approval_key, tool, input, context_json, policy_json,
          status, decision, reason, workspace_id, created_at, updated_at, decided_at
        ) VALUES (
          @id, @approval_key, @tool, @input, @context_json, @policy_json,
          @status, @decision, @reason, @workspace_id, @created_at, @updated_at, @decided_at
        ) ON CONFLICT(approval_key) DO NOTHING
      `),
      getToolApprovalByKey: this.db.prepare('SELECT * FROM tool_approvals WHERE approval_key = ? AND workspace_id = ? LIMIT 1'),
      getToolApprovalById: this.db.prepare('SELECT * FROM tool_approvals WHERE id = ? AND workspace_id = ? LIMIT 1'),
      listPendingToolApprovals: this.db.prepare(`
        SELECT *
        FROM tool_approvals
        WHERE workspace_id = ? AND status = 'pending'
        ORDER BY updated_at DESC
        LIMIT ?
      `),
      countPendingToolApprovals: this.db.prepare(`
        SELECT COUNT(*) AS c
        FROM tool_approvals
        WHERE workspace_id = ? AND status = 'pending'
      `),
      listUnresolvedToolApprovals: this.db.prepare(`
        SELECT *
        FROM tool_approvals
        WHERE workspace_id = ? AND status IN ('pending', 'executing', 'failed')
        ORDER BY updated_at DESC
        LIMIT ?
      `),
      countUnresolvedToolApprovals: this.db.prepare(`
        SELECT COUNT(*) AS c
        FROM tool_approvals
        WHERE workspace_id = ? AND status IN ('pending', 'executing', 'failed')
      `),
      // Keyset page for recoverExpiredToolApprovals (#426).
      //
      // Ordered by `id` rather than `updated_at`, and paged by cursor rather
      // than OFFSET: recovery writes `updated_at` on every row it fails, so an
      // updated_at-ordered OFFSET scan reorders rows mid-walk and silently
      // skips approvals that shifted past the window. `id` is the PRIMARY KEY
      // and recovery never rewrites it, so an id cursor stays stable.
      //
      // Narrowed to status = 'executing' because that is the only status the
      // recovery loop acts on; pending/failed rows were fetched and discarded
      // in JS before, which was the bulk of the scan.
      listExecutingToolApprovalsAfter: this.db.prepare(`
        SELECT *
        FROM tool_approvals
        WHERE status = 'executing' AND id > ?
        ORDER BY id
        LIMIT ?
      `),
      claimToolApproval: this.db.prepare(`
        UPDATE tool_approvals
        SET status = 'executing',
            decision = 'approved',
            reason = @reason,
            updated_at = @updated_at
        WHERE id = @id
          AND workspace_id = @workspace_id
          AND status = 'pending'
      `),
      claimToolApprovalWithLease: this.db.prepare(`
        UPDATE tool_approvals
        SET status = 'executing',
            decision = 'approved',
            reason = @reason,
            context_json = @context_json,
            updated_at = @updated_at
        WHERE id = @id
          AND workspace_id = @workspace_id
          AND status = 'pending'
      `),
      renewToolApprovalLease: this.db.prepare(`
        UPDATE tool_approvals
        SET context_json = @context_json,
            updated_at = @updated_at
        WHERE id = @id
          AND workspace_id = @workspace_id
          AND status = 'executing'
          AND context_json = @expected_context_json
      `),
      failExpiredToolApproval: this.db.prepare(`
        UPDATE tool_approvals
        SET status = 'failed',
            decision = 'execution_outcome_unknown',
            reason = @reason,
            decided_at = @decided_at,
            updated_at = @updated_at
        WHERE id = @id
          AND workspace_id = @workspace_id
          AND status = 'executing'
          AND context_json = @expected_context_json
      `),
      rejectToolApproval: this.db.prepare(`
        UPDATE tool_approvals
        SET status = 'rejected',
            decision = 'rejected',
            reason = @reason,
            decided_at = @decided_at,
            updated_at = @updated_at
        WHERE id = @id
          AND workspace_id = @workspace_id
          AND status = 'pending'
      `),
      failToolApproval: this.db.prepare(`
        UPDATE tool_approvals
        SET status = 'failed',
            decision = 'execution_outcome_unknown',
            reason = @reason,
            decided_at = @decided_at,
            updated_at = @updated_at
        WHERE id = @id
          AND workspace_id = @workspace_id
          AND status = 'executing'
      `),
      // The status guard is what makes an approval decision one-way (#422).
      // Without it this statement matched on `id` alone, so a second resolve
      // rewrote an already-finalized approval -- and because an unrecognized
      // decision maps to 'pending', it could drag an approved or rejected row
      // *backwards* into 'pending'.
      //
      // The guard is `IN ('pending','executing')`, not `= 'pending'`: the real
      // MCP approval path claims the row into 'executing' first
      // (claimToolApprovalWithLease), runs the action, and only then calls
      // resolveToolApproval to finalize it. Guarding on 'pending' alone would
      // break that legitimate finalization. 'approved', 'rejected' and 'failed'
      // are terminal and stay that way.
      resolveToolApproval: this.db.prepare(`
        UPDATE tool_approvals
        SET status = @status,
            decision = @decision,
            reason = @reason,
            decided_at = @decided_at,
            updated_at = @updated_at
        WHERE id = @id
          AND workspace_id = @workspace_id
          AND status IN ('pending', 'executing')
      `),
      finalizeToolApprovalWithReceipt: this.db.prepare(`
        UPDATE tool_approvals
        SET status = @status,
            decision = @decision,
            reason = @reason,
            context_json = @context_json,
            decided_at = @decided_at,
            updated_at = @updated_at
        WHERE id = @id
          AND workspace_id = @workspace_id
          AND status = @expected_status
      `),
    };
  }

  _now() {
    return Date.now();
  }

  // `id` is a PRIMARY KEY on every table here, and a bare `${prefix}-${now}`
  // collides for any two records created within the same millisecond (#412).
  // For tool_approvals that is not absorbed by the upsert: ON CONFLICT is
  // declared on approval_key, so two *different* approvals landing on the same
  // id raise SQLITE_CONSTRAINT_PRIMARYKEY instead. Keep the timestamp prefix so
  // ids stay roughly time-ordered, and append randomness for uniqueness --
  // the same shape agent.js already uses for its run ids.
  _newId(prefix) {
    return `${prefix}-${this._now()}-${crypto.randomBytes(6).toString('hex')}`;
  }

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


  _hydrateToolApproval(row) {
    return {
      ...row,
      context: safeParse(row.context_json, {}),
      policy: safeParse(row.policy_json, {}),
    };
  }

  close() {
    if (this.db) this.db.close();
  }
}

Object.assign(HuqanStorage.prototype, toolApprovalMethods);

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

module.exports = HuqanStorage;
