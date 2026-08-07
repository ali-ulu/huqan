'use strict';

/**
 * Schema and migration coverage that does not need better-sqlite3: the
 * migration set is data, and applyStorageSchema() only needs something
 * shaped like a database handle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BASE_SCHEMA_SQL,
  ADDITIVE_COLUMNS,
  SCHEMA_INDEXES,
  applyStorageSchema,
} = require('../lib/storage/schema');

/**
 * Records every statement, and reports whichever columns the caller says
 * already exist so both migration branches can be exercised.
 */
function fakeDb(existingColumns = {}) {
  const executed = [];
  return {
    executed,
    exec(sql) { executed.push(String(sql).trim()); },
    prepare(sql) {
      const match = /PRAGMA table_info\((\w+)\)/.exec(sql);
      return {
        all: () => (match ? (existingColumns[match[1]] || []) : []).map((name) => ({ name })),
      };
    },
  };
}

const ALL_PRESENT = {
  agent_runs: ['id', 'iterations', 'workspace_id', 'iterations_delta'],
  checkpoints: ['id', 'goal_key', 'workspace_id'],
};

// ─── the migration set ───────────────────────────────────────────────────────

test('every additive migration is fully specified', () => {
  for (const migration of ADDITIVE_COLUMNS) {
    assert.ok(migration.table, 'migration needs a table');
    assert.ok(migration.column, 'migration needs a column');
    assert.ok(migration.definition, `${migration.table}.${migration.column} needs a definition`);
    assert.ok(migration.reason, `${migration.table}.${migration.column} needs a stated reason`);
  }
});

test('no migration drops or rewrites a column', () => {
  for (const migration of ADDITIVE_COLUMNS) {
    assert.ok(!/\bDROP\b/i.test(migration.definition));
    if (migration.backfillSql) {
      assert.ok(!/\bDROP\b|\bDELETE\b/i.test(migration.backfillSql),
        'a backfill must not delete rows');
    }
  }
});

test('workspace columns exist for both agent_runs and checkpoints', () => {
  const pairs = ADDITIVE_COLUMNS.map((m) => `${m.table}.${m.column}`);
  assert.ok(pairs.includes('agent_runs.workspace_id'));
  assert.ok(pairs.includes('checkpoints.workspace_id'));
});

test('the iterations_delta migration backfills from the cumulative column', () => {
  const migration = ADDITIVE_COLUMNS.find((m) => m.column === 'iterations_delta');
  assert.ok(migration, 'iterations_delta migration must exist');
  assert.equal(migration.table, 'agent_runs');
  assert.match(migration.backfillSql, /SET iterations_delta = iterations/,
    'an upgraded database must keep its current budget reading, not drop to zero');
});

test('base schema declares the tables the rest of storage depends on', () => {
  for (const table of ['checkpoints', 'goal_memory', 'agent_runs', 'tool_approvals']) {
    assert.match(BASE_SCHEMA_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});

test('every index is guarded by IF NOT EXISTS', () => {
  for (const sql of SCHEMA_INDEXES) {
    assert.match(sql, /CREATE INDEX IF NOT EXISTS/);
  }
});

// ─── the runner ──────────────────────────────────────────────────────────────

test('a fresh database gets the base schema, every column and every index', () => {
  const db = fakeDb();
  const { addedColumns } = applyStorageSchema(db);

  assert.equal(addedColumns.length, ADDITIVE_COLUMNS.length, 'all columns are missing on a fresh db');
  assert.equal(db.executed[0], BASE_SCHEMA_SQL.trim(), 'base schema runs first');
  for (const sql of SCHEMA_INDEXES) {
    assert.ok(db.executed.includes(sql), `missing index: ${sql}`);
  }
});

test('an already-migrated database adds no columns and stays idempotent', () => {
  const db = fakeDb(ALL_PRESENT);
  const { addedColumns } = applyStorageSchema(db);

  assert.deepEqual(addedColumns, []);
  assert.equal(db.executed.some((sql) => /ALTER TABLE/i.test(sql)), false);
  assert.equal(db.executed.some((sql) => /UPDATE agent_runs/i.test(sql)), false,
    'a backfill must not re-run on an already-migrated database');
});

test('a partially-migrated database only gets what it is missing', () => {
  const db = fakeDb({
    agent_runs: ['id', 'iterations', 'workspace_id'],
    checkpoints: ['id', 'goal_key', 'workspace_id'],
  });
  const { addedColumns } = applyStorageSchema(db);

  assert.deepEqual(addedColumns, ['agent_runs.iterations_delta']);
  assert.ok(db.executed.some((sql) => /UPDATE agent_runs SET iterations_delta/.test(sql)),
    'the new column is backfilled');
});

test('a backfill runs immediately after its own ALTER, before indexes', () => {
  const db = fakeDb();
  applyStorageSchema(db);

  const alterAt = db.executed.findIndex((sql) => /ADD COLUMN iterations_delta/.test(sql));
  const backfillAt = db.executed.findIndex((sql) => /UPDATE agent_runs SET iterations_delta/.test(sql));
  const firstIndexAt = db.executed.findIndex((sql) => /CREATE INDEX/.test(sql));

  assert.ok(alterAt >= 0 && backfillAt >= 0 && firstIndexAt >= 0);
  assert.ok(backfillAt > alterAt, 'backfill must follow the column it fills');
  assert.ok(firstIndexAt > backfillAt, 'indexes come last, after migrated columns exist');
});

test('indexes over migrated columns are created after the migrations', () => {
  const db = fakeDb();
  applyStorageSchema(db);

  const lastAlterAt = db.executed.reduce((acc, sql, i) => (/ALTER TABLE/i.test(sql) ? i : acc), -1);
  const workspaceIndexAt = db.executed.findIndex((sql) => /idx_checkpoints_workspace_goal_updated/.test(sql));

  assert.ok(workspaceIndexAt > lastAlterAt,
    'an index on a migrated column must not run before that column exists');
});

// ─── migrations are atomic (#426) ────────────────────────────────────────────

/** A fake handle that supports better-sqlite3's db.transaction(fn) idiom. */
function transactionalFakeDb(existingColumns = {}, opts = {}) {
  const db = fakeDb(existingColumns);
  const committed = [];
  db.committed = committed;
  db.transaction = (work) => () => {
    const mark = db.executed.length;
    try {
      work();
      committed.push(...db.executed.slice(mark));
    } catch (err) {
      // Roll back: drop everything the failed unit executed.
      db.executed.length = mark;
      throw err;
    }
  };
  if (opts.failOn) {
    const realExec = db.exec.bind(db);
    db.exec = (sql) => {
      if (opts.failOn.test(String(sql))) throw new Error('simulated failure');
      realExec(sql);
    };
  }
  return db;
}

test('the migration set runs inside a transaction when the handle supports one', () => {
  const db = transactionalFakeDb();
  const { transactional, addedColumns } = applyStorageSchema(db);

  assert.equal(transactional, true, 'a half-applied migration must not be possible');
  assert.equal(addedColumns.length, ADDITIVE_COLUMNS.length);
  assert.ok(db.committed.some((sql) => /ALTER TABLE/i.test(sql)),
    'the ALTERs must run through the transaction wrapper, not around it');
});

test('a failed backfill rolls back its column instead of leaving it default-filled', () => {
  // iterations_delta defaulting to 0 while its backfill is missing reads as
  // "no budget spent" -- the exact fail-open the column exists to close.
  const db = transactionalFakeDb({}, { failOn: /UPDATE agent_runs SET iterations_delta/ });

  assert.throws(() => applyStorageSchema(db), /simulated failure/);
  assert.equal(db.executed.some((sql) => /ADD COLUMN iterations_delta/.test(sql)), false,
    'the column must not survive a rollback without its backfill');
});

test('a handle without transaction support still migrates, and says so', () => {
  const db = fakeDb();
  const { transactional, addedColumns } = applyStorageSchema(db);

  assert.equal(transactional, false, 'callers must be able to tell it ran unwrapped');
  assert.equal(addedColumns.length, ADDITIVE_COLUMNS.length, 'it should still migrate');
});

test('an already-migrated database opens no transaction at all', () => {
  const db = transactionalFakeDb(ALL_PRESENT);
  const { addedColumns, transactional } = applyStorageSchema(db);

  assert.deepEqual(addedColumns, []);
  assert.equal(transactional, true, 'no pending work means nothing to wrap, reported as clean');
  assert.deepEqual(db.committed, [], 'no migration unit should have been committed');
});
