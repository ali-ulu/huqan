const path = require('path');
let Database;

function loadDatabaseOrThrow() {
  if (Database) {
    return Database;
  }
  try {
    Database = require('better-sqlite3');
    return Database;
  } catch (error) {
    const wrapped = new Error('better-sqlite3 is required for v3 storage');
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeGoal(goal) {
  return String(goal || '').trim();
}

function lower(goal) {
  return normalizeGoal(goal).toLowerCase();
}

function resolveDbPath(opts = {}, kernel) {
  if (Object.prototype.hasOwnProperty.call(opts, 'dbPath') && opts.dbPath) {
    return opts.dbPath;
  }
  const graphMemoryPath = kernel?.graph?.memoryPath;
  if (typeof graphMemoryPath === 'string' && graphMemoryPath.endsWith('.json')) {
    return graphMemoryPath.replace(/\.json$/, '.db');
  }
  return path.join(process.cwd(), 'memory.db');
}

class AxiomStorage {
  constructor(opts = {}) {
    this.kernel = opts.kernel;
    this.dbPath = resolveDbPath(opts, this.kernel);
    const SQLiteDatabase = loadDatabaseOrThrow();
    this.db = new SQLiteDatabase(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        goal_key TEXT NOT NULL,
        goal TEXT NOT NULL,
        state_json TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        budget_remaining INTEGER NOT NULL,
        last_action TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'running',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_goal_key_updated
        ON checkpoints(goal_key, updated_at DESC);

      CREATE TABLE IF NOT EXISTS goal_memory (
        key TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        objective TEXT NOT NULL DEFAULT 'investigate',
        success_count INTEGER NOT NULL DEFAULT 0,
        blocked_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        resumed_count INTEGER NOT NULL DEFAULT 0,
        last_status TEXT NOT NULL DEFAULT 'unknown',
        pattern_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        goal_key TEXT NOT NULL,
        goal TEXT NOT NULL,
        objective TEXT NOT NULL DEFAULT 'investigate',
        status TEXT NOT NULL DEFAULT 'running',
        report TEXT NOT NULL DEFAULT '',
        state_json TEXT NOT NULL DEFAULT '{}',
        iterations INTEGER NOT NULL DEFAULT 0,
        completed_steps INTEGER NOT NULL DEFAULT 0,
        budget_remaining INTEGER NOT NULL DEFAULT 0,
        resumed INTEGER NOT NULL DEFAULT 0,
        checkpoint_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runs_goal_key_updated
        ON agent_runs(goal_key, updated_at DESC);

      CREATE TABLE IF NOT EXISTS tool_approvals (
        id TEXT PRIMARY KEY,
        approval_key TEXT NOT NULL UNIQUE,
        tool TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '',
        context_json TEXT NOT NULL DEFAULT '{}',
        policy_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        decision TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        decided_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_tool_approvals_status_updated
        ON tool_approvals(status, updated_at DESC);
    `);

    this._stmts = {
      upsertCheckpoint: this.db.prepare(`
        INSERT INTO checkpoints (
          id, goal_key, goal, state_json, iteration, budget_remaining,
          last_action, evidence_json, status, created_at, updated_at
        ) VALUES (
          @id, @goal_key, @goal, @state_json, @iteration, @budget_remaining,
          @last_action, @evidence_json, @status, @created_at, @updated_at
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
          updated_at = excluded.updated_at
      `),
      getLatestCheckpoint: this.db.prepare(`
        SELECT *
        FROM checkpoints
        WHERE goal_key = ? AND status != 'completed'
        ORDER BY updated_at DESC
        LIMIT 1
      `),
      deleteCheckpoint: this.db.prepare('DELETE FROM checkpoints WHERE id = ?'),
      upsertGoalMemory: this.db.prepare(`
        INSERT INTO goal_memory (
          key, goal, objective, success_count, blocked_count, error_count,
          resumed_count, last_status, pattern_json, created_at, updated_at
        ) VALUES (
          @key, @goal, @objective, @success_count, @blocked_count, @error_count,
          @resumed_count, @last_status, @pattern_json, @created_at, @updated_at
        )
        ON CONFLICT(key) DO UPDATE SET
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
      upsertRun: this.db.prepare(`
        INSERT INTO agent_runs (
          id, goal_key, goal, objective, status, report, state_json,
          iterations, completed_steps, budget_remaining, resumed, checkpoint_id,
          created_at, updated_at
        ) VALUES (
          @id, @goal_key, @goal, @objective, @status, @report, @state_json,
          @iterations, @completed_steps, @budget_remaining, @resumed, @checkpoint_id,
          @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          goal_key = excluded.goal_key,
          goal = excluded.goal,
          objective = excluded.objective,
          status = excluded.status,
          report = excluded.report,
          state_json = excluded.state_json,
          iterations = excluded.iterations,
          completed_steps = excluded.completed_steps,
          budget_remaining = excluded.budget_remaining,
          resumed = excluded.resumed,
          checkpoint_id = excluded.checkpoint_id,
          updated_at = excluded.updated_at
      `),
      countRuns: this.db.prepare('SELECT COUNT(*) AS c FROM agent_runs'),
      countGoals: this.db.prepare('SELECT COUNT(*) AS c FROM goal_memory'),
      countCheckpoints: this.db.prepare('SELECT COUNT(*) AS c FROM checkpoints'),
      upsertToolApproval: this.db.prepare(`
        INSERT INTO tool_approvals (
          id, approval_key, tool, input, context_json, policy_json,
          status, decision, reason, created_at, updated_at, decided_at
        ) VALUES (
          @id, @approval_key, @tool, @input, @context_json, @policy_json,
          @status, @decision, @reason, @created_at, @updated_at, @decided_at
        )
        ON CONFLICT(approval_key) DO UPDATE SET
          tool = excluded.tool,
          input = excluded.input,
          context_json = excluded.context_json,
          policy_json = excluded.policy_json,
          status = excluded.status,
          decision = excluded.decision,
          reason = excluded.reason,
          updated_at = excluded.updated_at,
          decided_at = excluded.decided_at
      `),
      getToolApprovalByKey: this.db.prepare('SELECT * FROM tool_approvals WHERE approval_key = ? LIMIT 1'),
      getToolApprovalById: this.db.prepare('SELECT * FROM tool_approvals WHERE id = ? LIMIT 1'),
      listPendingToolApprovals: this.db.prepare(`
        SELECT *
        FROM tool_approvals
        WHERE status = 'pending'
        ORDER BY updated_at DESC
        LIMIT ?
      `),
      countPendingToolApprovals: this.db.prepare(`
        SELECT COUNT(*) AS c
        FROM tool_approvals
        WHERE status = 'pending'
      `),
      resolveToolApproval: this.db.prepare(`
        UPDATE tool_approvals
        SET status = @status,
            decision = @decision,
            reason = @reason,
            decided_at = @decided_at,
            updated_at = @updated_at
        WHERE id = @id
      `),
    };
  }

  _now() {
    return Date.now();
  }

  saveCheckpoint(state = {}) {
    const id = String(state.checkpointId || state.id || `checkpoint-${this._now()}`);
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
      created_at: Number(state.startedAtMs || this._now()),
      updated_at: this._now(),
    };
    this._stmts.upsertCheckpoint.run(payload);
    return id;
  }

  loadLatestCheckpoint(goal) {
    const row = this._stmts.getLatestCheckpoint.get(lower(goal));
    if (!row) return null;
    return {
      ...row,
      evidence: safeParse(row.evidence_json, []),
      state: safeParse(row.state_json, null),
    };
  }

  deleteCheckpoint(id) {
    if (!id) return false;
    this._stmts.deleteCheckpoint.run(String(id));
    return true;
  }

  saveGoalMemory(record = {}) {
    const goal = normalizeGoal(record.goal);
    const key = lower(goal);
    const current = this.getGoalMemory(goal) || {
      key,
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

  getGoalMemory(goal) {
    const row = this._stmts.getGoalMemory.get(lower(goal));
    if (!row) return null;
    return {
      ...row,
      pattern: safeParse(row.pattern_json, {}),
    };
  }

  saveRun(state = {}) {
    const id = String(state.memoryId || state.runId || state.id || `run-${this._now()}`);
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
      completed_steps: Number(state.completedSteps || 0),
      budget_remaining: Number(state.budgetRemaining || 0),
      resumed: state.resumed ? 1 : 0,
      checkpoint_id: String(state.checkpointId || state.resumeToken || ''),
      created_at: Number(state.startedAtMs || this._now()),
      updated_at: this._now(),
    };
    this._stmts.upsertRun.run(payload);
    return id;
  }

  countRuns() {
    return Number(this._stmts.countRuns.get()?.c || 0);
  }

  countGoals() {
    return Number(this._stmts.countGoals.get()?.c || 0);
  }

  countCheckpoints() {
    return Number(this._stmts.countCheckpoints.get()?.c || 0);
  }

  saveToolApproval(record = {}) {
    const id = String(record.id || `approval-${this._now()}`);
    const approvalKey = String(record.approvalKey || `${lower(record.tool)}:${lower(record.input)}:${lower(record.context?.goal || '')}:${String(record.policy?.action || '')}`);
    const tool = String(record.tool || '');
    const input = String(record.input || '');
    const context = record.context && typeof record.context === 'object' ? record.context : {};
    const policy = record.policy && typeof record.policy === 'object' ? record.policy : {};
    const status = String(record.status || 'pending');
    const decision = String(record.decision || '');
    const reason = String(record.reason || '');
    const now = this._now();
    const payload = {
      id,
      approval_key: approvalKey,
      tool,
      input,
      context_json: JSON.stringify(context),
      policy_json: JSON.stringify(policy),
      status,
      decision,
      reason,
      created_at: Number(record.createdAt || now),
      updated_at: now,
      decided_at: Number(record.decidedAt || 0),
    };
    this._stmts.upsertToolApproval.run(payload);
    return this.getToolApprovalByKey(approvalKey);
  }

  getToolApprovalByKey(approvalKey) {
    const row = this._stmts.getToolApprovalByKey.get(String(approvalKey || ''));
    return row ? this._hydrateToolApproval(row) : null;
  }

  getToolApprovalById(id) {
    const row = this._stmts.getToolApprovalById.get(String(id || ''));
    return row ? this._hydrateToolApproval(row) : null;
  }

  listPendingToolApprovals(limit = 20) {
    const rows = this._stmts.listPendingToolApprovals.all(Math.max(1, Number(limit) || 20));
    return rows.map(row => this._hydrateToolApproval(row));
  }

  countPendingToolApprovals() {
    return Number(this._stmts.countPendingToolApprovals.get()?.c || 0);
  }

  resolveToolApproval(id, decision = 'approved', reason = '') {
    if (!id) return null;
    const existing = this.getToolApprovalById(id);
    if (!existing) return null;
    const status = decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'pending';
    const now = this._now();
    this._stmts.resolveToolApproval.run({
      id: String(id),
      status,
      decision: String(decision || ''),
      reason: String(reason || ''),
      decided_at: status === 'pending' ? 0 : now,
      updated_at: now,
    });
    return this.getToolApprovalById(id);
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

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

module.exports = AxiomStorage;
