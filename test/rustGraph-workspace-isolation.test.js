const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RustGraph = require('../rustGraph');

/**
 * Workspace isolation across the Rust bridge (#759).
 *
 * The Rust process keyed nodes and edges by bare id, so the same id in two
 * workspaces aliased one record: writes overwrote each other and reads crossed
 * the tenant boundary. Identity is now `(workspace, id)` on both sides, using
 * the same key shape as lib/graph-record-utils.js#nodeStorageKey.
 *
 * CI does not build huqan-core, so these run only where `cargo build --release`
 * has been run in huqan-core/. They are reported as skipped, never as passing,
 * when the binary is absent -- the same convention as the #361 IPC test above
 * them in test/rustGraph-provenance.test.js.
 */
const hasRustBinary = fs.existsSync(RustGraph.resolveRustBin());
const skip = hasRustBinary ? false : 'huqan-core binary not built in this environment';

function withGraph(fn) {
  return async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustgraph-workspace-'));
    const rg = new RustGraph({ memoryPath: path.join(tempDir, 'memory.json') });
    try {
      await fn(rg, tempDir);
      assert.equal(rg._fallback, null,
        'the bridge degraded to its JS fallback, so this asserted nothing about Rust');
    } finally {
      rg.destroy();
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
}

test('the same node id in two workspaces is two records', { skip }, withGraph(async (rg) => {
  await rg.addNode('musteri', 'A etiketi', { workspaceId: 'ws-a' });
  await rg.addNode('musteri', 'B etiketi', { workspaceId: 'ws-b' });

  const a = await rg.getNode('musteri', 'ws-a');
  const b = await rg.getNode('musteri', 'ws-b');

  assert.equal(a.label, 'A etiketi', 'workspace B overwrote workspace A');
  assert.equal(b.label, 'B etiketi');
  assert.equal(a.workspaceId, 'ws-a');
  assert.equal(b.workspaceId, 'ws-b');

  const stats = await rg.getStats();
  assert.equal(stats.nodes, 2, 'the two workspaces collapsed into one node');
}));

test('a read without a workspace does not reach into another one', { skip }, withGraph(async (rg) => {
  await rg.addNode('musteri', 'A etiketi', { workspaceId: 'ws-a' });

  assert.equal(await rg.getNode('musteri'), null, 'an unscoped read saw a scoped node');
  assert.equal(await rg.getWeight('musteri'), 0);
  assert.deepEqual(await rg.getEdges('musteri'), []);
}));

test('a legacy unscoped write lands in default, not everywhere', { skip }, withGraph(async (rg) => {
  await rg.addNode('musteri', 'legacy', {});

  const viaDefault = await rg.getNode('musteri', 'default');
  assert.ok(viaDefault, 'an unscoped write must be readable as the default workspace');
  assert.equal(viaDefault.workspaceId, 'default', 'workspace must be recorded, not left blank');
  assert.equal(await rg.getNode('musteri', 'ws-a'), null, 'default leaked into a named workspace');
}));

test('identical edges in two workspaces do not collide', { skip }, withGraph(async (rg) => {
  for (const workspaceId of ['ws-a', 'ws-b']) {
    await rg.addNode('kedi', 'kedi', { workspaceId });
    await rg.addNode('evcil', 'evcil', { workspaceId });
  }
  await rg.addEdge('kedi', 'evcil', 'is', { workspaceId: 'ws-a', confidence: 0.9, sourceRef: 'src-a' });
  await rg.addEdge('kedi', 'evcil', 'is', { workspaceId: 'ws-b', confidence: 0.2, sourceRef: 'src-b' });

  const a = await rg.getEdges('kedi', 'ws-a');
  const b = await rg.getEdges('kedi', 'ws-b');

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].sourceRef, 'src-a', 'workspace B rewrote workspace A\'s edge');
  assert.equal(b[0].sourceRef, 'src-b');
  assert.equal(a[0].confidence, 0.9);
  assert.equal(b[0].confidence, 0.2);

  const stats = await rg.getStats();
  assert.equal(stats.edges, 2, 'the two workspaces shared a single edge record');
}));

test('an edge cannot be drawn to a node that only exists in another workspace', { skip }, withGraph(async (rg) => {
  await rg.addNode('kedi', 'kedi', { workspaceId: 'ws-a' });
  await rg.addNode('evcil', 'evcil', { workspaceId: 'ws-b' });

  const edge = await rg.addEdge('kedi', 'evcil', 'is', { workspaceId: 'ws-a' });
  assert.equal(edge, null, 'an edge crossed the workspace boundary');
  assert.deepEqual(await rg.getEdges('kedi', 'ws-a'), []);
}));

test('in-edges are workspace-scoped too', { skip }, withGraph(async (rg) => {
  for (const workspaceId of ['ws-a', 'ws-b']) {
    await rg.addNode('kedi', 'kedi', { workspaceId });
    await rg.addNode('evcil', 'evcil', { workspaceId });
    await rg.addEdge('kedi', 'evcil', 'is', { workspaceId });
  }

  assert.equal((await rg.getInEdges('evcil', 'ws-a')).length, 1);
  assert.equal((await rg.getInEdges('evcil', 'ws-b')).length, 1);
  assert.deepEqual(await rg.getInEdges('evcil'), [], 'default saw another workspace\'s in-edges');
}));

test('removing a node removes only its own workspace, with its own edges', { skip }, withGraph(async (rg) => {
  for (const workspaceId of ['ws-a', 'ws-b']) {
    await rg.addNode('kedi', 'kedi', { workspaceId });
    await rg.addNode('evcil', 'evcil', { workspaceId });
    await rg.addEdge('kedi', 'evcil', 'is', { workspaceId });
  }

  assert.equal(await rg.removeNode('kedi', 'ws-a'), true);

  assert.equal(await rg.getNode('kedi', 'ws-a'), null);
  assert.ok(await rg.getNode('kedi', 'ws-b'), 'removing from one workspace removed the other');
  assert.equal((await rg.getEdges('kedi', 'ws-b')).length, 1, 'the surviving workspace lost its edge');
  assert.equal(await rg.removeNode('kedi', 'ws-a'), false, 'a second remove must report nothing removed');
}));

test('similarity is computed within a workspace, not across them', { skip }, withGraph(async (rg) => {
  // Identical vectors, deliberately: keyed globally these two score 1.0, so a
  // non-zero result here is proof the comparison crossed the boundary.
  await rg.learn('kedi hayvandir', { workspaceId: 'ws-a' });
  await rg.learn('kopek hayvandir', { workspaceId: 'ws-b' });

  assert.equal(await rg.cosineSimilarity('kedi', 'kopek', 'ws-a'), 0,
    'similarity was computed against a node from another workspace');
  assert.equal(await rg.cosineSimilarity('kedi', 'kopek', 'ws-b'), 0);

  // ...and within one workspace it still works.
  await rg.learn('kus hayvandir', { workspaceId: 'ws-a' });
  assert.ok(await rg.cosineSimilarity('kedi', 'kus', 'ws-a') > 0,
    'scoping the read broke same-workspace similarity');
}));

test('save/load round-trips both workspaces separately', { skip }, withGraph(async (rg, tempDir) => {
  await rg.addNode('musteri', 'A etiketi', { workspaceId: 'ws-a' });
  await rg.addNode('musteri', 'B etiketi', { workspaceId: 'ws-b' });
  await rg.addNode('musteri', 'legacy', {});

  const snapshotPath = path.join(tempDir, 'snapshot.json');
  assert.equal(await rg.save(snapshotPath), true);

  const reopened = new RustGraph({ memoryPath: path.join(tempDir, 'memory.json') });
  try {
    assert.equal(await reopened.load(snapshotPath), true);
    assert.equal((await reopened.getNode('musteri', 'ws-a')).label, 'A etiketi');
    assert.equal((await reopened.getNode('musteri', 'ws-b')).label, 'B etiketi');
    assert.equal((await reopened.getNode('musteri', 'default')).label, 'legacy');
    assert.equal((await reopened.getStats()).nodes, 3, 'the reload merged workspaces');
  } finally {
    reopened.destroy();
  }
}));

test('learn and ask stay inside their workspace', { skip }, withGraph(async (rg) => {
  await rg.learn('kedi hayvandir', { workspaceId: 'ws-a' });

  assert.notEqual(await rg.ask('kedi nedir', { workspaceId: 'ws-a' }), 'Bilmiyorum');
  assert.equal(await rg.ask('kedi nedir', { workspaceId: 'ws-b' }), 'Bilmiyorum',
    'a fact learned in one workspace answered another');
  assert.equal(await rg.ask('kedi nedir'), 'Bilmiyorum',
    'a scoped fact answered an unscoped question');
}));
