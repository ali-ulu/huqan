'use strict';

/**
 * Concurrent first-open of a fresh database (#3925).
 *
 * HUQAN's normal shape is several processes opening the same graph/memory file
 * at once -- the MCP server, the HTTP server and a CLI command all start
 * together on a fresh container. Each runs `applyStorageSchema`, which reads
 * `PRAGMA table_info` and then issues `ALTER TABLE ... ADD COLUMN`. A process
 * that loses that window got SQLite's `duplicate column name: strength` (or
 * `reviewed_by`) and crashed before it could open at all.
 *
 * The window is a few microseconds wide, so a plain N-process test is flaky by
 * construction: it passes most of the time even on the broken code. These tests
 * drive the interleave deterministically instead -- the losing process's ALTER
 * meets the real `duplicate column name` error from a real SQLite handle,
 * because the winning process's migration is applied in between -- and then
 * assert the loser opens cleanly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyStorageSchema, ADDITIVE_COLUMNS } = require('../lib/storage/schema');

function makeSandbox(t, label) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `huqan-schema-race-${label}-`));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function loadDatabase(t) {
  try {
    // eslint-disable-next-line global-require
    return require('better-sqlite3');
  } catch (_) {
    t.skip('better-sqlite3 unavailable');
    return null;
  }
}

test('#3925 a process whose ALTER loses the race still opens the database', t => {
  const Database = loadDatabase(t);
  if (!Database) return;
  const dbPath = path.join(makeSandbox(t, 'loser'), 'memory.db');

  // The loser: a real handle, but the first ALTER is preceded by the winner's
  // completed migration, so SQLite genuinely answers `duplicate column name`.
  const loser = new Database(dbPath);
  const winner = new Database(dbPath);
  let raced = false;
  const racingHandle = {
    exec: (sql) => {
      if (!raced && /ALTER TABLE/i.test(String(sql))) {
        raced = true;
        applyStorageSchema(winner);
      }
      return loser.exec(sql);
    },
    prepare: (sql) => loser.prepare(sql),
  };

  const result = applyStorageSchema(racingHandle);

  assert.equal(raced, true, 'the test must have exercised the losing window');
  // The winner added every column, so the loser added none and must not claim
  // otherwise: `addedColumns` drives the one-time backfill bookkeeping.
  assert.deepEqual(result.addedColumns, []);
  const columns = loser.prepare('PRAGMA table_info(agent_runs)').all().map(c => c.name);
  assert.ok(columns.includes('iterations_delta'), 'the winner\'s migration is present');
  loser.close();
  winner.close();
});

test('#3925 the one-time backfill does not re-run for the losing process', t => {
  const Database = loadDatabase(t);
  if (!Database) return;
  const dbPath = path.join(makeSandbox(t, 'backfill'), 'memory.db');

  const loser = new Database(dbPath);
  const winner = new Database(dbPath);
  const executed = [];
  let raced = false;
  const racingHandle = {
    exec: (sql) => {
      const statement = String(sql);
      executed.push(statement);
      if (!raced && /ALTER TABLE/i.test(statement)) {
        raced = true;
        applyStorageSchema(winner);
      }
      return loser.exec(statement);
    },
    prepare: (sql) => loser.prepare(sql),
  };

  applyStorageSchema(racingHandle);

  assert.equal(raced, true);
  // iterations_delta's backfill copies `iterations` into the new column. The
  // winner already ran it; running it again here would be harmless for this
  // column but is not harmless in general, and the loser must not believe it
  // migrated a column it did not.
  assert.equal(executed.some(sql => /UPDATE agent_runs SET iterations_delta/.test(sql)), false,
    'the losing process must not re-run a backfill the winner already committed');
  loser.close();
  winner.close();
});

test('#3925 a non-duplicate ALTER error is still fatal', t => {
  const Database = loadDatabase(t);
  if (!Database) return;
  const dbPath = path.join(makeSandbox(t, 'fatal'), 'memory.db');
  const db = new Database(dbPath);
  const failingHandle = {
    exec: (sql) => {
      if (/ALTER TABLE/i.test(String(sql))) throw new Error('disk I/O error');
      return db.exec(sql);
    },
    prepare: (sql) => db.prepare(sql),
  };

  assert.throws(() => applyStorageSchema(failingHandle), /disk I\/O error/,
    'only a duplicate-column race is absorbed; every other failure must propagate');
  db.close();
});

test('#3925 every additive column survives a lost race', t => {
  const Database = loadDatabase(t);
  if (!Database) return;
  const dbPath = path.join(makeSandbox(t, 'all'), 'memory.db');
  const loser = new Database(dbPath);
  const winner = new Database(dbPath);
  let raced = false;
  const racingHandle = {
    exec: (sql) => {
      if (!raced && /ALTER TABLE/i.test(String(sql))) {
        raced = true;
        applyStorageSchema(winner);
      }
      return loser.exec(sql);
    },
    prepare: (sql) => loser.prepare(sql),
  };

  applyStorageSchema(racingHandle);

  for (const migration of ADDITIVE_COLUMNS) {
    const columns = loser.prepare(`PRAGMA table_info(${migration.table})`).all().map(c => c.name);
    assert.ok(columns.includes(migration.column),
      `${migration.table}.${migration.column} must exist after the race`);
  }
  loser.close();
  winner.close();
});
