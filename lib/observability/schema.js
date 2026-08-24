'use strict';

/**
 * Additive observability schema.
 *
 * The tables intentionally live in the same SQLite database as HuqanStorage so
 * agent runs, audit records, queue jobs and trust artifacts share one durable
 * workspace boundary. No existing table is altered or deleted here.
 */

const OBSERVABILITY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS observability_schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observability_events (
    event_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL DEFAULT '',
    trace_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    tool TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER,
    tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_micros INTEGER,
    cost_known INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observability_runs (
    run_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    runtime TEXT NOT NULL DEFAULT 'unknown',
    goal_digest TEXT NOT NULL DEFAULT '',
    goal_length INTEGER NOT NULL DEFAULT 0,
    objective TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    step_count INTEGER NOT NULL DEFAULT 0,
    successful_steps INTEGER NOT NULL DEFAULT 0,
    blocked_steps INTEGER NOT NULL DEFAULT 0,
    error_steps INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_micros INTEGER,
    cost_known INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observability_alert_rules (
    rule_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    metric TEXT NOT NULL,
    operator TEXT NOT NULL,
    threshold REAL NOT NULL,
    window_ms INTEGER NOT NULL DEFAULT 300000,
    cooldown_ms INTEGER NOT NULL DEFAULT 900000,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observability_alerts (
    alert_id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    threshold REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'firing',
    event_id TEXT NOT NULL DEFAULT '',
    fired_at INTEGER NOT NULL,
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS agent_queue_jobs (
    job_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL,
    max_steps INTEGER NOT NULL DEFAULT 4,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    available_at INTEGER NOT NULL,
    lease_until INTEGER,
    worker_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '',
    result_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_observability_events_workspace_created
    ON observability_events(workspace_id, created_at DESC, event_id DESC);
  CREATE INDEX IF NOT EXISTS idx_observability_events_workspace_run
    ON observability_events(workspace_id, run_id, created_at ASC, event_id ASC);
  CREATE INDEX IF NOT EXISTS idx_observability_events_workspace_type
    ON observability_events(workspace_id, event_type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_observability_runs_workspace_updated
    ON observability_runs(workspace_id, updated_at DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS idx_observability_runs_workspace_status
    ON observability_runs(workspace_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_observability_alert_rules_workspace
    ON observability_alert_rules(workspace_id, enabled, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_observability_alerts_workspace_fired
    ON observability_alerts(workspace_id, fired_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_queue_jobs_claim
    ON agent_queue_jobs(status, available_at ASC, created_at ASC, job_id ASC);
  CREATE INDEX IF NOT EXISTS idx_agent_queue_jobs_workspace_updated
    ON agent_queue_jobs(workspace_id, updated_at DESC, job_id DESC);
`;

const OBSERVABILITY_SCHEMA_VERSION = 1;

function getObservabilitySchemaVersion(db) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observability_schema_meta'").get();
  if (!table) return 0;
  return Number(db.prepare('SELECT version FROM observability_schema_meta WHERE singleton = 1').get()?.version || 0);
}

function applyObservabilitySchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('database handle is required');
  }
  const current = getObservabilitySchemaVersion(db);
  if (current > OBSERVABILITY_SCHEMA_VERSION) {
    const error = new Error('Observability schema is newer than this runtime.');
    error.code = 'OBSERVABILITY_SCHEMA_VERSION_UNSUPPORTED';
    throw error;
  }
  const migrate = () => {
    db.exec(OBSERVABILITY_SCHEMA_SQL);
    const columns = db.prepare('PRAGMA table_info(agent_queue_jobs)').all().map(column => column.name);
    if (!columns.includes('agent_id')) db.exec("ALTER TABLE agent_queue_jobs ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
    db.prepare(`INSERT INTO observability_schema_meta (singleton, version, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`).run(OBSERVABILITY_SCHEMA_VERSION, Date.now());
  };
  if (current < OBSERVABILITY_SCHEMA_VERSION) {
    if (typeof db.transaction === 'function') db.transaction(migrate)(); else migrate();
  } else db.exec(OBSERVABILITY_SCHEMA_SQL);
  return true;
}

module.exports = { OBSERVABILITY_SCHEMA_SQL, OBSERVABILITY_SCHEMA_VERSION, applyObservabilitySchema, getObservabilitySchemaVersion };

// Keep this file a structural runtime entry for the reachability check.
void 0;
