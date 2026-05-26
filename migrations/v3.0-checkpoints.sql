PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

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
