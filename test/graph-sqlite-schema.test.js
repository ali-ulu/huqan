'use strict';

// #2126: the Graph SQLite schema (tables, legacy migrations, indexes,
// prepared statements) moved from graph.js _initDB to
// lib/graph-sqlite-schema.js. This pins the moved behaviour, including the
// legacy single-column-PK nodes migration that had no direct test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initGraphSchema, createGraphStmts } = require('../lib/graph-sqlite-schema');
const Graph = require('../graph');
const { readGraphSurfaceSource } = require('./helpers/graph-surface-source');

function tempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-2126-${name}-`));
  return { dir, dbPath: path.join(dir, 'graph.db'), memoryPath: path.join(dir, 'memory.json') };
}

test('#2126: initGraphSchema creates every table the store prepares statements for', () => {
  const Database = require('better-sqlite3');
  const { dbPath } = tempDb('schema');
  const db = new Database(dbPath);
  initGraphSchema(db, {});
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  for (const table of ['nodes', 'edges', 'audit_log', 'candidate_claims', 'mutation_journal', 'mutation_receipts']) {
    assert.ok(tables.has(table), `schema creates ${table}`);
  }
  const stmts = createGraphStmts(db);
  assert.ok(Object.keys(stmts).length > 20, 'statement set covers all tables');
  db.close();
});

// #3010: SQLite is a durable mirror, not a query engine. Reads go through the
// in-memory indexes, so a prepared read statement with no caller implies a
// capability that does not exist. This pins the statement set to exactly what
// the persistence/read paths call, so a dead statement cannot be reintroduced
// without a test having to say so.
test('#3010: the statement set is exactly the statements the runtime calls', () => {
  const Database = require('better-sqlite3');
  const { dbPath } = tempDb('stmts-exact');
  const db = new Database(dbPath);
  initGraphSchema(db, {});

  const stmts = createGraphStmts(db);
  assert.deepEqual(
    Object.keys(stmts).sort(),
    [
      'allAuditEvents', 'allCandidateClaims', 'allEdges', 'allNodes',
      'countAuditEvents', 'deleteEdgesOf', 'deleteNode',
      'getLatestMutationReceiptHash', 'getMutationJournal',
      'getMutationReceiptById', 'getMutationReceiptByOperation', 'getMutationReceiptSeal', 'getNode',
      'insertAuditEvent', 'insertMutationJournal', 'insertMutationReceipt', 'insertMutationReceiptSeal',
      'pruneEdges', 'touchNode', 'updateEdgeWeight', 'upsertCandidateClaim',
      'upsertEdge', 'upsertNode',
    ],
    'the prepared-statement set must match the callers in source',
  );

  // The eight #3010 removals, named so a reintroduction fails here and not in
  // production. Each had zero callers; the in-memory read path covers the
  // equivalent read/delete behaviour.
  for (const removed of [
    'getEdge', 'getEdges', 'getInEdges', 'getCandidateClaim',
    'countNodes', 'countEdges', 'deleteEdge', 'updateNodeVector',
  ]) {
    assert.ok(!Object.hasOwn(stmts, removed), `${removed} was removed by #3010 and must not return dead`);
  }

  db.close();
});

// #4560: writeNodeRow used to re-prepare its own node upsert on every row and
// that SQL carried `vector = excluded.vector` while the cached upsertNode did
// not. Routing the row writer through upsertNode is only correct once the
// cached statement updates vector on conflict too, or a re-written node would
// keep its old vector.
test('#4560: upsertNode updates the vector column on conflict', () => {
  const Database = require('better-sqlite3');
  const { dir, dbPath } = tempDb('upsert-node-vector');
  const db = new Database(dbPath);
  initGraphSchema(db, {});
  const stmts = createGraphStmts(db);

  stmts.upsertNode.run('n1', 'default', 'first', 0.5, 1, 't0', 1, 't0', '{"v":[1]}', 'null');
  stmts.upsertNode.run('n1', 'default', 'second', 0.6, 1, 't0', 2, 't1', '{"v":[2]}', 'null');

  const row = db.prepare('SELECT label, weight, vector FROM nodes WHERE id = ?').get('n1');
  assert.equal(row.label, 'second', 'upsert updates the label on conflict');
  assert.equal(row.weight, 0.6, 'upsert updates the weight on conflict');
  assert.equal(row.vector, '{"v":[2]}', 'upsert updates the vector on conflict');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#2126: legacy single-PK nodes table migrates with data preserved', () => {
  const Database = require('better-sqlite3');
  const { dir, dbPath, memoryPath } = tempDb('legacy');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5,
      created INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT '',
      last_accessed INTEGER NOT NULL, last_seen TEXT NOT NULL DEFAULT '',
      vector TEXT NOT NULL DEFAULT '{}', provenance TEXT NOT NULL DEFAULT 'null'
    );
    INSERT INTO nodes (id, label, weight, created, last_accessed, vector)
    VALUES ('n1', 'legacy node', 0.7, 123, 456, '{}');
  `);
  legacy.close();

  const graph = new Graph({ memoryPath, dbPath, useSQLite: true });
  graph.load();
  const node = graph.getNode('n1', 'default');
  assert.ok(node, 'migrated node is readable in the default workspace');
  assert.equal(node.label, 'legacy node');
  graph.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#2126: graph.js _initDB is a thin delegation with no inline SQL', () => {
  const source = readGraphSurfaceSource();
  assert.ok(source.includes("require('./lib/graph-sqlite-schema')"), 'graph requires the schema module');
  assert.ok(!source.includes('CREATE TABLE IF NOT EXISTS nodes'), 'node DDL moved out');
  assert.ok(!source.includes('CREATE TABLE IF NOT EXISTS edges'), 'edge DDL moved out');
  assert.ok(!source.includes("require('./lib/graph-sqlite-pragmas')"), 'pragma require moved out with its use');
  const delegate = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-sqlite-schema.js'), 'utf8');
  assert.ok(!delegate.includes("require('./graph')") && !delegate.includes('require("../graph")'), 'schema has no cycle back');
});
