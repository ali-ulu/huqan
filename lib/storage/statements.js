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
    getLatestCheckpoint: db.prepare(`
      SELECT *
      FROM checkpoints
      WHERE goal_key = ? AND workspace_id = ? AND status != 'completed'
      ORDER BY updated_at DESC
      LIMIT 1
    `),
    getCheckpointById: db.prepare('SELECT * FROM checkpoints WHERE id = ? AND goal_key = ? AND workspace_id = ? AND status != \'completed\' LIMIT 1'),
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
