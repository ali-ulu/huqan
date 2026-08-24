'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const Database = require('better-sqlite3');

test('Graph SQLite commits use FULL durability for audit-critical state (#1132)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-durability-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
  });

  try {
    if (graph.getStats().backend !== 'sqlite') {
      t.skip('better-sqlite3 is unavailable');
      return;
    }

    assert.equal(graph._db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(graph._db.pragma('synchronous', { simple: true }), 2);
  } finally {
    graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Graph fails closed when an existing SQLite file is not a database', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-corrupt-init-'));
  const dbPath = path.join(root, 'memory.db');
  fs.writeFileSync(dbPath, 'not-a-sqlite-database');

  try {
    assert.throws(
      () => new Graph({ memoryPath: path.join(root, 'memory.json'), dbPath, useSQLite: true }),
      error => error?.code === 'SQLITE_PERSISTENCE_INIT_FAILED',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Graph fails closed on malformed persisted SQLite JSON instead of loading an empty graph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-corrupt-row-'));
  const memoryPath = path.join(root, 'memory.json');
  const dbPath = path.join(root, 'memory.db');
  const graph = new Graph({ memoryPath, dbPath, useSQLite: true });

  try {
    if (graph.getStats().backend !== 'sqlite') {
      return;
    }
    graph.addNode('persisted', 'Persisted');
    graph.save();
    graph.close();

    const db = new Database(dbPath);
    try {
      db.prepare('UPDATE nodes SET vector = ? WHERE id = ?').run('not-json', 'persisted');
    } finally {
      db.close();
    }

    const reloaded = new Graph({ memoryPath, dbPath, useSQLite: true });
    assert.throws(
      () => reloaded.load(),
      error => error?.code === 'SQLITE_PERSISTENCE_LOAD_FAILED',
    );
    reloaded.close();
  } finally {
    try { graph.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
