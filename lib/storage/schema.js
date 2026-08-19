'use strict';

/**
 * HuqanStorage schema and migrations.
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
    workspace_id TEXT NOT NULL DEFAULT 'default',
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
  Object.freeze({
    table: 'goal_memory',
    column: 'workspace_id',
    definition: "TEXT NOT NULL DEFAULT 'default'",
    // goal_memory was keyed on lowercased goal text alone, with no workspace
    // predicate anywhere, while checkpoints and agent_runs were already
    // scoped. Two workspaces planning the same goal therefore shared success/
    // blocked/error/resume counts, last status and pattern_json -- which
    // carries lastFinalAnswer and the selected tool list. Workspace A could
    // read B's execution history by planning the same text, and B's outcomes
    // accumulated into A's record (#757).
    //
    // `key` is the PRIMARY KEY and SQLite cannot alter that in place, so the
    // scope lives in the key itself: workspaceId + US + lowercased goal. The
    // backfill rewrites pre-existing rows into the 'default' workspace, which
    // is the workspace they were already implicitly under -- so an upgraded
    // database keeps reading its own history instead of losing it, without
    // that history becoming visible to any other workspace.
    backfillSql: "UPDATE goal_memory SET key = 'default' || char(31) || key WHERE instr(key, char(31)) = 0",
    reason: 'goal memory workspace isolation',
  }),
]);

const SCHEMA_INDEXES = Object.freeze([
  'CREATE INDEX IF NOT EXISTS idx_checkpoints_goal_key_updated ON checkpoints(goal_key, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_goal_key_updated ON agent_runs(goal_key, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_tool_approvals_status_updated ON tool_approvals(status, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_created ON agent_runs(workspace_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_updated ON agent_runs(workspace_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace_goal_updated ON checkpoints(workspace_id, goal_key, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_goal_memory_workspace ON goal_memory(workspace_id)',
]);

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

/**
 * Runs `work` inside a database transaction when the handle supports one.
 *
 * better-sqlite3 exposes `db.transaction(fn)`, which returns a wrapped
 * function; graph.js already uses that idiom. A handle without it (a test
 * double, or a different driver) still runs the work, because refusing to
 * migrate would be worse than migrating unwrapped -- but callers can tell the
 * difference from the returned `transactional` flag rather than having to
 * assume.
 */
function runInTransaction(db, work) {
  if (typeof db.transaction === 'function') {
    db.transaction(work)();
    return true;
  }
  work();
  return false;
}

/**
 * Creates the base tables, applies any missing additive columns (each with its
 * one-time backfill, all inside one transaction), then creates indexes.
 *
 * @param {object} db a better-sqlite3-style handle exposing exec() and prepare()
 * @returns {{addedColumns: string[], transactional: boolean}} which columns this
 *   call added, and whether the migration ran wrapped in a transaction
 */
function applyStorageSchema(db) {
  db.exec(BASE_SCHEMA_SQL);

  const pending = ADDITIVE_COLUMNS.filter(
    (migration) => !tableColumns(db, migration.table).includes(migration.column),
  );

  const addedColumns = [];
  let transactional = true;

  if (pending.length > 0) {
    // Each ALTER and its backfill must land together. Applying a column and
    // then failing before its backfill leaves rows whose new column holds the
    // default rather than the migrated value -- for iterations_delta that
    // silently reads as "no budget spent", which is exactly the fail-open this
    // column exists to close. SQLite makes DDL transactional, so one
    // transaction around the whole set is enough.
    const applied = [];
    transactional = runInTransaction(db, () => {
      applied.length = 0;
      for (const migration of pending) {
        db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`);
        if (migration.backfillSql) db.exec(migration.backfillSql);
        applied.push(`${migration.table}.${migration.column}`);
      }
    });
    addedColumns.push(...applied);
  }

  // Indexes run outside the migration transaction and after it: they are
  // idempotent (IF NOT EXISTS) and several of them reference columns the
  // migrations add, so they must not run before those columns exist.
  for (const indexSql of SCHEMA_INDEXES) {
    db.exec(indexSql);
  }

  return { addedColumns, transactional };
}

module.exports = {
  runInTransaction,
  BASE_SCHEMA_SQL,
  ADDITIVE_COLUMNS,
  SCHEMA_INDEXES,
  applyStorageSchema,
};
