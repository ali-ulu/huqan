'use strict';

/**
 * AxiomStorage schema and migrations.
 *
 * Extracted from storage.js so the schema is described as data rather than as
 * a hundred lines of inline `db.exec` calls. Two things fall out of that:
 * migrations become reviewable in one place, and the whole thing becomes
 * testable without a real database -- `applyStorageSchema` only needs
 * something that looks like a better-sqlite3 handle, so the migration list and
 * the runner can both be verified without better-sqlite3 installed.
 *
 * Migration style follows the PRAGMA table_info + conditional ALTER TABLE
 * idiom already used in graph.js: additive only, never destructive, and safe
 * to run on every open.
 */

const BASE_SCHEMA_SQL = `
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
`;

/**
 * Columns added after the base schema shipped. Each entry is applied only when
 * the column is absent, so opening an old database upgrades it in place.
 *
 * `backfillSql` runs exactly once, immediately after the column is added, and
 * exists so an upgrade does not silently change the meaning of existing rows.
 */
const ADDITIVE_COLUMNS = Object.freeze([
  Object.freeze({
    table: 'agent_runs',
    column: 'workspace_id',
    definition: "TEXT NOT NULL DEFAULT 'default'",
    // AB10: lets cumulative per-workspace iteration usage be queried without
    // introducing a second table.
    reason: 'per-workspace loop budget accounting',
  }),
  Object.freeze({
    table: 'checkpoints',
    column: 'workspace_id',
    definition: "TEXT NOT NULL DEFAULT 'default'",
    // Without this a checkpoint is keyed on goal alone, so a run in one
    // workspace can resume another workspace's paused state. Existing rows
    // adopt 'default', the workspace they were already implicitly under.
    reason: 'checkpoint workspace isolation',
  }),
  Object.freeze({
    table: 'agent_runs',
    column: 'iterations_delta',
    definition: 'INTEGER NOT NULL DEFAULT 0',
    // `iterations` is cumulative for a goal: a resumed run rewrites the whole
    // running total, so summing that column counted the same iterations once
    // per resume. `iterations_delta` records what a single saveRun() actually
    // spent, which is the only figure a rolling window can sum correctly.
    //
    // The backfill copies `iterations` into the new column for rows written
    // before it existed. That reproduces exactly what the old query summed,
    // so an upgraded database keeps its current budget reading instead of
    // dropping to zero.
    backfillSql: 'UPDATE agent_runs SET iterations_delta = iterations',
    reason: 'per-run iteration delta for windowed budget accounting',
  }),
]);

const SCHEMA_INDEXES = Object.freeze([
  'CREATE INDEX IF NOT EXISTS idx_checkpoints_goal_key_updated ON checkpoints(goal_key, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_goal_key_updated ON agent_runs(goal_key, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_tool_approvals_status_updated ON tool_approvals(status, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_created ON agent_runs(workspace_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_updated ON agent_runs(workspace_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace_goal_updated ON checkpoints(workspace_id, goal_key, updated_at DESC)',
]);

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

/**
 * Creates the base tables, applies any missing additive columns (with their
 * one-time backfills), then creates indexes. Indexes come last because some
 * of them reference columns the migrations add.
 *
 * @param {object} db a better-sqlite3-style handle exposing exec() and prepare()
 * @returns {{addedColumns: string[]}} which columns this call actually added
 */
function applyStorageSchema(db) {
  db.exec(BASE_SCHEMA_SQL);

  const addedColumns = [];
  for (const migration of ADDITIVE_COLUMNS) {
    if (tableColumns(db, migration.table).includes(migration.column)) continue;

    db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`);
    if (migration.backfillSql) db.exec(migration.backfillSql);
    addedColumns.push(`${migration.table}.${migration.column}`);
  }

  for (const indexSql of SCHEMA_INDEXES) {
    db.exec(indexSql);
  }

  return { addedColumns };
}

module.exports = {
  BASE_SCHEMA_SQL,
  ADDITIVE_COLUMNS,
  SCHEMA_INDEXES,
  applyStorageSchema,
};
