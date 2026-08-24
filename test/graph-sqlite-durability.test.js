'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');

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
