const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RustGraph = require('../rustGraph');
const Graph = require('../graph');

test('rustGraph addNode/addEdge forward provenance/workspaceId/weight/confidence/evidence/sourceRef to the JS fallback graph (#361)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustgraph-provenance-'));
  let rg;
  try {
    rg = new RustGraph({ memoryPath: path.join(tempDir, 'memory.json') });
    // Force the JS-fallback path directly (this environment may or may not have
    // the compiled Rust binary) so this assertion always runs in CI.
    rg._fallback = new Graph({ memoryPath: path.join(tempDir, 'memory.json') });
    rg._ready = true;

    const provenance = { actor: 'test-actor', source: 'unit-test' };
    await rg.addNode('kedi', 'kedi', { provenance, workspaceId: 'ws-a' });
    await rg.addNode('evcil', 'evcil', { workspaceId: 'ws-a' });
    await rg.addEdge('kedi', 'evcil', 'is', {
      provenance,
      workspaceId: 'ws-a',
      weight: 0.7,
      confidence: 0.8,
      evidence: ['ev-1'],
      sourceRef: 'src-1',
    });

    const storedNode = rg._fallback.getNode('kedi', 'ws-a');
    assert.ok(storedNode);
    assert.deepEqual(storedNode.provenance, provenance);
    assert.equal(storedNode.workspaceId, 'ws-a');

    const storedEdges = rg._fallback.getEdges('kedi', 'ws-a');
    assert.equal(storedEdges.length, 1);
    assert.equal(storedEdges[0].to, 'evcil');
    assert.deepEqual(storedEdges[0].provenance, provenance);
    assert.equal(storedEdges[0].workspaceId, 'ws-a');
    assert.equal(storedEdges[0].confidence, 0.8);
    assert.equal(storedEdges[0].source_ref, 'src-1');
    assert.ok(storedEdges[0].evidence.includes('ev-1'));
  } finally {
    // rg._fallback holds an open SQLite handle; rg.destroy() closes it.
    // Without this the directory removal below hits EPERM on Windows
    // because a leaked handle keeps the temp dir's db file open.
    rg?.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const rustBin = RustGraph.resolveRustBin();
const hasRustBinary = fs.existsSync(rustBin);

test(
  'rustGraph addNode/addEdge forward provenance through the real Rust IPC process (#361)',
  { skip: hasRustBinary ? false : 'axiom-core binary not built in this environment' },
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustgraph-ipc-provenance-'));
    const rg = new RustGraph({ memoryPath: path.join(tempDir, 'memory.json') });
    try {
      const provenance = { actor: 'ipc-test' };
      await rg.addNode('kedi', 'kedi', { provenance, workspaceId: 'ws-ipc' });
      await rg.addNode('evcil', 'evcil', { workspaceId: 'ws-ipc' });
      await rg.addEdge('kedi', 'evcil', 'is', {
        provenance,
        workspaceId: 'ws-ipc',
        confidence: 0.9,
        evidence: ['ev-ipc'],
        sourceRef: 'src-ipc',
      });

      // Reads are workspace-scoped now (#759), so they name the workspace the
      // node was written into rather than finding it by bare id.
      const node = await rg.getNode('kedi', 'ws-ipc');
      assert.deepEqual(node.provenance, provenance);
      assert.equal(node.workspaceId, 'ws-ipc');

      const edges = await rg.getEdges('kedi', 'ws-ipc');
      assert.equal(edges.length, 1);
      assert.deepEqual(edges[0].provenance, provenance);
      assert.equal(edges[0].workspaceId, 'ws-ipc');
      assert.equal(edges[0].confidence, 0.9);
      assert.equal(edges[0].sourceRef, 'src-ipc');
      assert.ok(edges[0].evidence.includes('ev-ipc'));
    } finally {
      rg.destroy();
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
