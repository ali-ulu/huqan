'use strict';
// #2147: every prepared statement the observability service runs, prepared
// once per database handle.
function prepareObservabilityStatements(db) {
  return {
    insertEvent: db.prepare(`INSERT INTO observability_events (
      event_id, workspace_id, run_id, trace_id, agent_id, event_type, status, tool,
      duration_ms, tokens, input_tokens, output_tokens, cost_micros, cost_known,
      payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    upsertRun: db.prepare(`INSERT INTO observability_runs (
      run_id, workspace_id, agent_id, runtime, goal_digest, goal_length, objective,
      status, started_at, finished_at, duration_ms, step_count, successful_steps,
      blocked_steps, error_steps, tokens, input_tokens, output_tokens, cost_micros,
      cost_known, error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      agent_id = excluded.agent_id,
      runtime = excluded.runtime,
      goal_digest = excluded.goal_digest,
      goal_length = excluded.goal_length,
      objective = excluded.objective,
      status = excluded.status,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      duration_ms = excluded.duration_ms,
      step_count = excluded.step_count,
      successful_steps = excluded.successful_steps,
      blocked_steps = excluded.blocked_steps,
      error_steps = excluded.error_steps,
      tokens = excluded.tokens,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cost_micros = excluded.cost_micros,
      cost_known = excluded.cost_known,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at`),
    getRun: db.prepare('SELECT * FROM observability_runs WHERE workspace_id = ? AND run_id = ?'),
    getLatestAlert: db.prepare(`SELECT * FROM observability_alerts
      WHERE workspace_id = ? AND rule_id = ? ORDER BY fired_at DESC LIMIT 1`),
    getAlert: db.prepare('SELECT * FROM observability_alerts WHERE workspace_id = ? AND alert_id = ?'),
    listActiveAlerts: db.prepare(`SELECT * FROM observability_alerts
      WHERE workspace_id = ? AND rule_id = ? AND status IN ('firing', 'acknowledged')
      ORDER BY fired_at DESC, alert_id DESC`),
    acknowledgeAlert: db.prepare(`UPDATE observability_alerts SET status = 'acknowledged'
      WHERE workspace_id = ? AND alert_id = ? AND status = 'firing'`),
    resolveAlert: db.prepare(`UPDATE observability_alerts SET status = 'resolved', resolved_at = ?
      WHERE workspace_id = ? AND alert_id = ? AND status IN ('firing', 'acknowledged')`),
    insertAlert: db.prepare(`INSERT INTO observability_alerts
      (alert_id, rule_id, workspace_id, metric, value, threshold, status, event_id, fired_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, 'firing', ?, ?, NULL)`),
    getRules: db.prepare(`SELECT * FROM observability_alert_rules
      WHERE workspace_id = ? ORDER BY updated_at DESC, rule_id DESC LIMIT ?`),
    getRule: db.prepare('SELECT * FROM observability_alert_rules WHERE workspace_id = ? AND rule_id = ?'),
    getEnabledRules: db.prepare(`SELECT * FROM observability_alert_rules
      WHERE workspace_id = ? AND enabled = 1 ORDER BY rule_id ASC LIMIT ?`),
    insertRuleIfWithinLimit: db.prepare(`INSERT INTO observability_alert_rules
      (rule_id, workspace_id, name, metric, operator, threshold, window_ms, cooldown_ms, enabled, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM observability_alert_rules WHERE workspace_id = ?) < ?`),
    deleteRule: db.prepare('DELETE FROM observability_alert_rules WHERE workspace_id = ? AND rule_id = ?'),
    listAlerts: db.prepare(`SELECT * FROM observability_alerts
      WHERE workspace_id = ? ORDER BY fired_at DESC, alert_id DESC LIMIT ?`),
    countQueue: db.prepare(`SELECT COUNT(*) AS count FROM agent_queue_jobs
      WHERE workspace_id = ? AND status IN ('queued', 'running')`),
    insertJob: db.prepare(`INSERT INTO agent_queue_jobs
      (job_id, workspace_id, agent_id, goal, max_steps, status, attempts, max_attempts,
       available_at, lease_until, worker_id, run_id, result_json, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, '', '', '{}', '', ?, ?)`),
    getJob: db.prepare('SELECT * FROM agent_queue_jobs WHERE workspace_id = ? AND job_id = ?'),
    listJobs: db.prepare(`SELECT * FROM agent_queue_jobs
      WHERE workspace_id = ? ORDER BY updated_at DESC, job_id DESC LIMIT ?`),
    listToolsByRun: db.prepare(`SELECT tool, COUNT(*) AS call_count FROM observability_events
      WHERE workspace_id = ? AND run_id = ? AND event_type = 'step_finished' AND tool <> ''
      GROUP BY tool ORDER BY call_count DESC, tool ASC`),
    nextJob: db.prepare(`SELECT * FROM agent_queue_jobs
      WHERE status = 'queued' AND available_at <= ? ORDER BY available_at ASC, created_at ASC, job_id ASC LIMIT 1`),
    claimJob: db.prepare(`UPDATE agent_queue_jobs SET status = 'running', attempts = attempts + 1,
      lease_until = ?, worker_id = ?, updated_at = ? WHERE job_id = ? AND status = 'queued'`),
    completeJob: db.prepare(`UPDATE agent_queue_jobs SET status = ?, lease_until = NULL,
      worker_id = '', run_id = ?, result_json = ?, error_code = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND worker_id = ?`),
    retryJob: db.prepare(`UPDATE agent_queue_jobs SET status = ?, available_at = ?, lease_until = NULL,
      worker_id = '', error_code = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND worker_id = ?`),
    expiredLeases: db.prepare(`SELECT * FROM agent_queue_jobs
      WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
      ORDER BY lease_until ASC, job_id ASC`),
    recoverLease: db.prepare(`UPDATE agent_queue_jobs SET status = ?, lease_until = NULL,
      worker_id = '', available_at = ?, error_code = 'WORKER_LEASE_EXPIRED', updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_until = ?`),
  };
}
module.exports = { prepareObservabilityStatements };
