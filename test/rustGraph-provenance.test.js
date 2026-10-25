const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RustGraph = require('../rustGraph');
const Graph = require('../graph');
const Kernel = require('../kernel');
const { commitLearnOutcome } = require('../lib/learn-use-case-steps');

// The caller path must be pinned, not only the bridge: dropping either option
// in lib/learn-use-case-steps.js leaves the direct RustGraph.learn tests green.
// The CI coverage job builds no Rust binary, so a real Kernel carries
// `_rust = null` there; the stub keeps this path executing in every job.
test('Kernel.learn forwards workspaceId and provenance to the native mirror (#4236)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustgraph-provenance-kernel-'));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, 'memory.json'),
  });
  const native = kernel._rust;
  const calls = [];
  native?.destroy();
  kernel._rust = {
    learn: (text, options) => {
      calls.push({ text, options });
      return Promise.resolve(true);
    },
  };

  try {
    const provenance = {
      provenanceId: 'caller-path-test',
      sourceRef: 'test:si-04',
      sourceType: 'manual',
      actor: 'test',
      workspaceId: 'ws-caller-path',
    };
    kernel.learn('kedi memelidir', {
      ...Kernel.createAdmissionBypassOpts('SI-04 caller-path test'),
      workspaceId: 'ws-caller-path',
      provenance,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, 'kedi memelidir');
    assert.equal(calls[0].options.workspaceId, 'ws-caller-path');
    // buildProvenance normalizes the caller's record; the identity fields must
    // survive into the mirror call.
    assert.equal(calls[0].options.provenance.provenanceId, 'caller-path-test');
    assert.equal(calls[0].options.provenance.workspaceId, 'ws-caller-path');
  } finally {
    kernel.graph.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('commitLearnOutcome forwards workspaceId and provenance to the native learn mirror (#4236)', async () => {
  const mirror = [];
  const kernel = {
    plugins: { emit: () => {} },
    _admissionReceiptDetails: (admission) => ({ admission }),
    graph: { save: () => {} },
    _autoMaintain: () => {},
    ok: (kind, payload, evidence, meta) => ({ kind, payload, evidence, meta }),
    // The stub stands in for the native accelerator: the coverage job runs
    // without a Rust binary, so this is the only way the mirror call executes.
    _rust: {
      learn: (text, opts) => {
        mirror.push({ text, opts });
        return Promise.resolve(true);
      },
    },
  };
  const provenance = { provenanceId: 'prov-mirror', source: 'unit-test' };
  const state = {
    conflicts: [],
    alternatives: [],
    metadata: {},
    workspaceId: 'ws-mirror-kernel',
    admission: null,
    learned: 1,
    parsed: [{ subject: 'kedi', relation: 'is', object: 'memeli' }],
    evidence: { facts: 1 },
    provenance,
    provenanceWarnings: [],
    afterCommitEffects: null,
  };

  const result = commitLearnOutcome.call(kernel, 'kedi memelidir', { deferSave: true }, state);

  assert.equal(result.kind, 'learn');
  assert.deepEqual(mirror, [{
    text: 'kedi memelidir',
    opts: { workspaceId: 'ws-mirror-kernel', provenance },
  }]);
});

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
  { skip: hasRustBinary ? false : 'huqan-core binary not built in this environment' },
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

// #4236 (SI-04): the learn mirror must carry workspaceId and provenance to the
// native side, so a learned fact lands in the requested workspace with its
// evidence instead of falling back to the default workspace with a null
// provenance.
test('rustGraph learn forwards workspaceId and provenance on the wire (#4236)', async () => {
  const graph = new RustGraph({ memoryPath: 'unused.json' });
  const calls = [];
  graph.send = async (command) => {
    calls.push(command);
    return { ok: true };
  };

  try {
    const provenance = { actor: 'mirror-test', source: 'unit-test' };
    await graph.learn('kedi memelidir', { workspaceId: 'ws-mirror', provenance });
    assert.deepEqual(calls, [{
      cmd: 'learn',
      text: 'kedi memelidir',
      workspaceId: 'ws-mirror',
      provenance,
    }]);
  } finally {
    graph.destroy();
  }
});

test(
  'rustGraph learn writes into the requested workspace with provenance through the real Rust IPC process (#4236)',
  { skip: hasRustBinary ? false : 'huqan-core binary not built in this environment' },
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustgraph-ipc-learn-'));
    const rg = new RustGraph({ memoryPath: path.join(tempDir, 'memory.json') });
    try {
      const provenance = { actor: 'learn-ipc-test' };
      await rg.learn('kedi memelidir', { workspaceId: 'ws-learn-ipc', provenance });

      const node = await rg.getNode('kedi', 'ws-learn-ipc');
      assert.ok(node, 'the learned subject must land in the requested workspace');
      assert.deepEqual(node.provenance, provenance);
      assert.equal(node.workspaceId, 'ws-learn-ipc');

      // #759 reads are workspace-scoped: the node must not leak into default.
      const leaked = await rg.getNode('kedi', 'default');
      assert.equal(leaked, null);
    } finally {
      rg.destroy();
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);

test(
  'native addNode keeps stored provenance when the wire carries an explicit null (#4236)',
  { skip: hasRustBinary ? false : 'huqan-core binary not built in this environment' },
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustgraph-ipc-null-provenance-'));
    const rg = new RustGraph({ memoryPath: path.join(tempDir, 'memory.json') });
    try {
      const provenance = { actor: 'null-parity-test' };
      await rg.addNode('kedi', 'kedi', { provenance, workspaceId: 'ws-null-parity' });
      // The learn mirror always sends provenance (null when the caller supplied
      // none). lib/graph-node-write.js treats null as "keep existing"; the Rust
      // backend must agree instead of erasing the stored provenance.
      await rg.addNode('kedi', 'kedi', { provenance: null, workspaceId: 'ws-null-parity' });

      const node = await rg.getNode('kedi', 'ws-null-parity');
      assert.deepEqual(node.provenance, provenance);
    } finally {
      rg.destroy();
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
