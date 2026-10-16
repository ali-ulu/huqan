'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { spawnFixture, tempDir, waitForExit, waitForLine } = require('./helpers');

test('SQLite write crash mid-transaction rolls back the uncommitted row and reopens cleanly', async (t) => {
  const root = tempDir(t, 'huqan-fault-sqlite-');
  const dbPath = path.join(root, 'memory.db');
  const child = spawnFixture('sqlite-mid-transaction-child.cjs', [dbPath]);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  await waitForLine(child);
  assert.equal(child.kill('SIGKILL'), true);
  await waitForExit(child);

  const db = new Database(dbPath);
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM fault_probe').get();
    assert.equal(row.count, 0);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');

    db.prepare('INSERT INTO fault_probe (value) VALUES (?)').run('recovered-write');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fault_probe').get().count, 1);
  } finally {
    db.close();
  }
});
