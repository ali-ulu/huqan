'use strict';

// #3011: save() used to rewrite every node and edge row on every call. These
// tests pin the replacement contract: after a checkpoint, a save writes only
// the records a mutation touched, while a full checkpoint (first save, load,
// or the size threshold) still writes every row.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');

function tempGraph(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-incremental-save-'));
  const graph = new Graph({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    useSQLite: true,
    ...options,
  });
  t.after(() => {
    try { graph.close(); } catch (_) {}
    // Best-effort cleanup, same rule as the stdio robustness test: sqlite
    // close_v2 leaves a zombie connection until the GC collects the last
    // transient Statement, and on Windows that zombie holds the file lock
    // (EBUSY) for a while after close. A locked temp dir must never turn a
    // passing assertion into a failing test (#3158); runners clean %TEMP%.
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) { /* locked by a GC-pending sqlite zombie; %TEMP% wins */ }
  });
  return graph;
}

// Counts the rows a save physically writes, by watching the node UPSERT (built
// inline in graph-persistence-runtime) and the edge UPSERT (a prepared
// statement). This measures the write amplification the issue is about, not an
// implementation detail: whatever statement a row goes through, it is counted.
function countRowWrites(graph) {
  const counts = { nodes: 0, edges: 0 };
  const originalPrepare = graph._db.prepare.bind(graph._db);
  graph._db.prepare = (sql) => {
    if (/INSERT INTO nodes/i.test(sql)) counts.nodes += 1;
    return originalPrepare(sql);
  };
  // Mutate `run` in place instead of spread-replacing the statement object:
  // a replaced object orphans the original prepared statement, and better-
  // sqlite3's close_v2 keeps a zombie connection while any Statement object
  // is alive -- on Windows that file lock makes the temp-dir cleanup fail
  // with EBUSY (#3158).
  const originalEdgeRun = graph._stmts.upsertEdge.run.bind(graph._stmts.upsertEdge);
  graph._stmts.upsertEdge.run = (...args) => { counts.edges += 1; return originalEdgeRun(...args); };
  return counts;
}

function seed(graph, nodeCount, edgeCount) {
  for (let i = 0; i < nodeCount; i += 1) graph.addNode(`n${i}`, `Node ${i}`);
  for (let i = 0; i < edgeCount; i += 1) {
    graph.addEdge(`n${i}`, `n${(i + 1) % nodeCount}`, 'relates', { weight: 0.5 });
  }
}

test('the first save writes the node row', (t) => {
  const graph = tempGraph(t);
  if (graph.getStats().backend !== 'sqlite') return t.skip('better-sqlite3 is unavailable');

  seed(graph, 1, 0);
  const counts = countRowWrites(graph);
  graph.save();

  assert.equal(counts.nodes, 1, 'the first save writes the node row');
  assert.equal(counts.edges, 0, 'there are no edges to write');
});

test('a single-node mutation writes one node row and no edge rows', (t) => {
  const graph = tempGraph(t);
  if (graph.getStats().backend !== 'sqlite') return t.skip('better-sqlite3 is unavailable');

  seed(graph, 20, 20);
  graph.save();

  graph.addNode('extra', 'Extra');
  const counts = countRowWrites(graph);
  graph.save();

  assert.equal(counts.nodes, 1, 'only the new node row is written');
  assert.equal(counts.edges, 0, 'unchanged edges are not rewritten');
});

test('a single-edge mutation writes one edge row and no node rows', (t) => {
  const graph = tempGraph(t);
  if (graph.getStats().backend !== 'sqlite') return t.skip('better-sqlite3 is unavailable');

  seed(graph, 20, 20);
  graph.save();

  graph.addEdge('n0', 'n5', 'supports', { weight: 0.7 });
  const counts = countRowWrites(graph);
  graph.save();

  // addEdge touches its two endpoints (lastAccessed), so those rows are
  // rewritten; the rest of the graph is not.
  assert.ok(counts.nodes <= 2, `only touched endpoint nodes are written (got ${counts.nodes})`);
  assert.equal(counts.edges, 1, 'only the new edge row is written');
});

test('an incremental save is durable: the row reloads from a fresh instance', (t) => {
  const graph = tempGraph(t);
  if (graph.getStats().backend !== 'sqlite') return t.skip('better-sqlite3 is unavailable');

  seed(graph, 20, 20);
  graph.save();
  graph.addNode('incremental', 'Incremental only');
  graph.addEdge('n0', 'n10', 'supports', { weight: 0.9 });
  graph.save();

  const reader = new Graph({
    memoryPath: graph.memoryPath,
    dbPath: graph._paths.dbPath,
    useSQLite: true,
  });
  t.after(() => reader.close());
  reader.load();

  assert.equal(reader.getNode('incremental').label, 'Incremental only');
  assert.equal(reader.getEdge('n0', 'n10', 'supports', 'default').weight, 0.9);
  assert.equal(reader.getNode('n0').label, 'Node 0', 'untouched rows survive an incremental save');
});

test('a load forces the next save to be a full checkpoint', (t) => {
  const graph = tempGraph(t);
  if (graph.getStats().backend !== 'sqlite') return t.skip('better-sqlite3 is unavailable');

  seed(graph, 20, 20);
  graph.save();
  graph.load();

  const counts = countRowWrites(graph);
  graph.save();

  assert.equal(counts.nodes, 20, 'a save after load checkpoints every node row');
  assert.equal(counts.edges, 20, 'a save after load checkpoints every edge row');
});

test('the checkpoint threshold switches a bulk delta back to a full rewrite', (t) => {
  const graph = tempGraph(t, { checkpointEvery: 4 });
  if (graph.getStats().backend !== 'sqlite') return t.skip('better-sqlite3 is unavailable');

  seed(graph, 8, 8);
  graph.save();

  for (let i = 0; i < 4; i += 1) graph.addNode(`bulk${i}`, `Bulk ${i}`);
  const counts = countRowWrites(graph);
  graph.save();

  assert.equal(counts.nodes, 12, 'a checkpoint at the threshold rewrites every node');
  assert.equal(counts.edges, 8, 'a checkpoint at the threshold rewrites every edge');
});

test('removals are not resurrected by a later incremental save', (t) => {
  const graph = tempGraph(t);
  if (graph.getStats().backend !== 'sqlite') return t.skip('better-sqlite3 is unavailable');

  seed(graph, 10, 10);
  graph.save();
  graph.removeNode('n3');
  graph.save();

  const reader = new Graph({ memoryPath: graph.memoryPath, dbPath: graph._paths.dbPath, useSQLite: true });
  t.after(() => reader.close());
  reader.load();

  assert.equal(reader.getNode('n3'), null, 'a removed node stays removed');
  assert.equal(reader.getNode('n0')?.label, 'Node 0', 'a surviving node is still present');
});

test('the JSON mirror is refreshed by an incremental save too', (t) => {
  const graph = tempGraph(t);
  if (graph.getStats().backend !== 'sqlite') return t.skip('better-sqlite3 is unavailable');

  seed(graph, 10, 10);
  graph.save();
  graph.addNode('mirrored', 'Mirrored');
  graph.save();

  const mirror = JSON.parse(fs.readFileSync(graph.memoryPath, 'utf8'));
  assert.ok(mirror.nodes['mirrored'], 'the mirror reflects the incremental change');
  assert.ok(mirror.nodes.n0, 'the mirror still carries the checkpointed records');
});
