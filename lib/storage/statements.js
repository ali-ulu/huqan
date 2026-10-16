// The prepared statements HuqanStorage runs, built once per connection (and
// again on reopen). Checkpoints, goal memory and runs are here; the tool
// approval statements are in statements-tool-approval.js. Moved out of
// storage.js's _init (#2165).

const { prepareToolApprovalStatements } = require('./statements-tool-approval');

function prepareStorageStatements(db) {
  return {
    upsertCheckpoint: db.prepare(`
      INSERT INTO checkpoints (
        id, goal_key, goal, state_json, iteration, budget_remaining,
        last_action, evidence_json, status, workspace_id, checkpoint_hash,
        previous_checkpoint_hash, created_at, updated_at
      ) VALUES (
        @id, @goal_key, @goal, @state_json, @iteration, @budget_remaining,
        @last_action, @evidence_json, @status, @workspace_id, @checkpoint_hash,
        @previous_checkpoint_hash, @created_at, @updated_at
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
        checkpoint_hash = excluded.checkpoint_hash,
        previous_checkpoint_hash = excluded.previous_checkpoint_hash,
        updated_at = excluded.updated_at
    `),
    getLatestCheckpoint: db.prepare(`
      SELECT *
      FROM checkpoints
      WHERE goal_key = ? AND workspace_id = ? AND status != 'completed'
      ORDER BY updated_at DESC
      LIMIT 1
    `),
    getCheckpointById: db.prepare('SELECT * FROM checkpoints WHERE id = ? AND goal_key = ? AND workspace_id = ? AND status != \'completed\' LIMIT 1'),
    // R36 (#3491): the tip of the hash chain for one goal+workspace, used as the
    // `previousCheckpointHash` of the next save. `id != ?` excludes the row being
    // re-saved so a re-save links to its predecessor rather than to itself.
    // Ordering is by rowid (first-insert order), not created_at: a resumed run
    // keeps its original startedAt, so created_at can be older than checkpoints
    // written after it, while an upsert preserves rowid. Unstamped legacy rows
    // (empty hash) are excluded so the chain starts at the first hashed row.
    getLatestCheckpointHash: db.prepare(`
      SELECT checkpoint_hash
      FROM checkpoints
      WHERE goal_key = ? AND workspace_id = ? AND checkpoint_hash != '' AND id != ?
      ORDER BY rowid DESC
      LIMIT 1
    `),
    // R36 (#3491): the hashed checkpoints of one goal+workspace in chain order,
    // so a restore can verify the whole lineage. Unstamped rows are omitted.
    getCheckpointChain: db.prepare(`
      SELECT *
      FROM checkpoints
      WHERE goal_key = ? AND workspace_id = ? AND checkpoint_hash != ''
      ORDER BY rowid ASC
    `),
    deleteCheckpoint: db.prepare('DELETE FROM checkpoints WHERE id = ? AND goal = ? AND workspace_id = ?'),
    upsertGoalMemory: db.prepare(`
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
    getGoalMemory: db.prepare('SELECT * FROM goal_memory WHERE key = ? LIMIT 1'),
    countGoalsForWorkspace: db.prepare('SELECT COUNT(*) AS c FROM goal_memory WHERE workspace_id = ?'),
    upsertRun: db.prepare(`
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
    sumAgentIterationsSince: db.prepare(`
      SELECT COALESCE(SUM(iterations_delta), 0) AS total
      FROM agent_runs
      WHERE workspace_id = ? AND updated_at >= ?
    `),
    countRuns: db.prepare('SELECT COUNT(*) AS c FROM agent_runs'),
    countGoals: db.prepare('SELECT COUNT(*) AS c FROM goal_memory'),
    countCheckpoints: db.prepare('SELECT COUNT(*) AS c FROM checkpoints'),
    ...prepareToolApprovalStatements(db),
  };
}

module.exports = { prepareStorageStatements };
