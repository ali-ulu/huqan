const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');

const BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

let tempDir;
let counter = 0;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-negation-'));
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function paths(name) {
  const memoryPath = path.join(tempDir, `${name}-${counter++}.json`);
  return { memoryPath };
}

function makeKernel({ memoryPath, useSQLite }) {
  const kernel = new Kernel({ memoryPath, useSQLite, noLoad: true, loadPlugins: false });
  return kernel;
}

/** Seeds a high-weight `subject --tür--> object` edge. */
function seedTur(graph, subject, object, workspaceId = 'default', weight = 0.9) {
  graph.addNode(subject, subject, null, { workspaceId });
  graph.addNode(object, object, null, { workspaceId });
  return graph.addEdge(subject, object, 'tür', { workspaceId, weight, confidence: weight });
}

describe('negation downgrades the canonical edge, not a clone (#732)', () => {
  it('read APIs still hand back detached clones', () => {
    const graph = new Graph({ ...paths('clone-isolation'), useSQLite: false, noLoad: true });
    seedTur(graph, 'kedi', 'hayvan');

    const [copy] = graph.getEdges('kedi', 'default');
    copy.weight = 0.01;
    copy.celiski = 'tampered';

    const canonical = graph.getEdge('kedi', 'hayvan', 'tür', 'default');
    assert.strictEqual(canonical.weight, 0.9, 'getEdges() must keep returning clones');
    assert.strictEqual(canonical.celiski, undefined);
  });

  it('downgradeEdge lowers the canonical edge in place', () => {
    const graph = new Graph({ ...paths('downgrade'), useSQLite: false, noLoad: true });
    seedTur(graph, 'kedi', 'hayvan');

    const result = graph.downgradeEdge({
      fromId: 'kedi', toId: 'hayvan', relation: 'tür',
      workspaceId: 'default', weight: 0.2, marker: 'downgraded',
    });

    assert.ok(result);
    assert.strictEqual(result.previous.weight, 0.9);
    const canonical = graph.getEdge('kedi', 'hayvan', 'tür', 'default');
    assert.strictEqual(canonical.weight, 0.2);
    assert.strictEqual(canonical.celiski, 'downgraded');
    assert.ok(canonical.confidence <= 0.2, 'confidence must follow the weight down');
  });

  it('downgradeEdge returns null for an edge in another workspace', () => {
    const graph = new Graph({ ...paths('scoped'), useSQLite: false, noLoad: true });
    seedTur(graph, 'kedi', 'hayvan', 'tenant-a');

    const miss = graph.downgradeEdge({
      fromId: 'kedi', toId: 'hayvan', relation: 'tür',
      workspaceId: 'tenant-b', weight: 0.2,
    });
    assert.strictEqual(miss, null);
    assert.strictEqual(graph.getEdge('kedi', 'hayvan', 'tür', 'tenant-a').weight, 0.9);
  });

  for (const useSQLite of [false, true]) {
    const label = useSQLite ? 'with SQLite' : 'without SQLite';

    it(`learning a copula negation downgrades the canonical tür edge (${label})`, () => {
      const { memoryPath } = paths(`learn-${useSQLite}`);
      const kernel = makeKernel({ memoryPath, useSQLite });
      const graph = kernel.graph;
      seedTur(graph, 'kedi', 'balik');

      const before = graph.getEdge('kedi', 'balik', 'tür', 'default');
      assert.strictEqual(before.weight, 0.9);

      const result = kernel.learn('kedi balik değildir', BYPASS);
      assert.ok(result.ok !== false, `learn failed: ${JSON.stringify(result.error || {})}`);

      // The original high-trust tür edge must not survive at its old weight.
      const after = graph.getEdge('kedi', 'balik', 'tür', 'default');
      assert.ok(after, 'the contradicted tür edge should remain, downgraded');
      assert.ok(after.weight <= 0.2, `canonical tür edge kept weight ${after.weight}`);
      assert.strictEqual(after.celiski, 'downgraded');

      // The negation itself is learned as its own edge.
      const negated = graph.getEdge('kedi', 'balik [değil]', 'değil', 'default');
      assert.ok(negated, 'negation edge was not recorded');
      kernel.graph.close?.();
    });

    it(`conflict text matches the persisted graph state (${label})`, () => {
      const { memoryPath } = paths(`conflict-text-${useSQLite}`);
      const kernel = makeKernel({ memoryPath, useSQLite });
      seedTur(kernel.graph, 'kedi', 'balik');

      const result = kernel.learn('kedi balik değildir', BYPASS);
      const conflicts = result?.data?.conflicts || [];
      const negation = conflicts.find((entry) => entry.type === 'negation');
      assert.ok(negation, `expected a negation conflict, got ${JSON.stringify(conflicts)}`);

      const claimed = /lowered to ([\d.]+)/.exec(negation.message);
      assert.ok(claimed, `message does not state the applied weight: ${negation.message}`);

      const survivor = kernel.graph.getEdge('kedi', 'balik', 'tür', 'default');
      assert.ok(survivor, 'no edge survived the downgrade');
      assert.strictEqual(
        Number(claimed[1]),
        survivor.weight,
        'conflict text must report the weight the graph actually holds',
      );
      kernel.graph.close?.();
    });
  }

  it('the downgrade survives a save and reopen with SQLite', () => {
    const { memoryPath } = paths('persistence');
    const first = makeKernel({ memoryPath, useSQLite: true });
    seedTur(first.graph, 'kedi', 'balik');
    first.learn('kedi balik değildir', BYPASS);
    first.graph.save();
    const expected = first.graph.getEdge('kedi', 'balik', 'tür', 'default');
    assert.ok(expected);
    first.graph.close?.();

    const reopened = new Graph({ memoryPath, useSQLite: true });
    reopened.load();
    const persisted = reopened.getEdge('kedi', 'balik', 'tür', 'default');
    assert.ok(persisted, 'downgraded edge did not survive reopen');
    assert.ok(persisted.weight <= 0.2, `reopened edge weight was ${persisted.weight}`);
    reopened.close?.();
  });
});

describe('temporal metadata stays scoped to the learn that wrote it (#733)', () => {
  it('leaves other workspaces and untouched edges alone', () => {
    const { memoryPath } = paths('kernelv2-scope');
    const kernel = makeKernel({ memoryPath, useSQLite: false });
    const v2 = new KernelV2({ kernel });
    const graph = kernel.graph;

    // Same triple in two workspaces, so a workspace-blind key would collapse them.
    for (const [workspaceId, source] of [['w1', 'source-a'], ['w2', 'source-b']]) {
      graph.addNode('alfa', 'alfa', null, { workspaceId });
      graph.addNode('beta', 'beta', null, { workspaceId });
      graph.addEdge('alfa', 'beta', 'tür', { workspaceId, source });
    }
    const beforeA = graph.getEdge('alfa', 'beta', 'tür', 'w1');
    const beforeB = graph.getEdge('alfa', 'beta', 'tür', 'w2');

    v2.learn('gama delta türüdür', { ...BYPASS, workspaceId: 'w1', source: 'source-c' });

    const afterA = graph.getEdge('alfa', 'beta', 'tür', 'w1');
    const afterB = graph.getEdge('alfa', 'beta', 'tür', 'w2');
    assert.strictEqual(afterA.source, beforeA.source, 'w1 edge was relabelled by an unrelated learn');
    assert.strictEqual(afterB.source, beforeB.source, 'w2 edge was relabelled across workspaces');
    assert.strictEqual(afterA.updatedAt, undefined);
    assert.strictEqual(afterB.updatedAt, undefined);

    // The edge the learn actually created does carry the new source.
    const created = graph.getAllEdges('w1').find((edge) => edge.from === 'gama');
    if (created) assert.strictEqual(created.source, 'source-c');
  });

  it('keeps provenance across a save and reopen with SQLite', () => {
    const { memoryPath } = paths('kernelv2-persist');
    const kernel = makeKernel({ memoryPath, useSQLite: true });
    const v2 = new KernelV2({ kernel });
    const graph = kernel.graph;

    for (const [workspaceId, source] of [['w1', 'source-a'], ['w2', 'source-b']]) {
      graph.addNode('alfa', 'alfa', null, { workspaceId });
      graph.addNode('beta', 'beta', null, { workspaceId });
      graph.addEdge('alfa', 'beta', 'tür', { workspaceId, source });
    }
    v2.learn('gama delta türüdür', { ...BYPASS, workspaceId: 'w1', source: 'source-c' });
    graph.save();
    graph.close?.();

    const reopened = new Graph({ memoryPath, useSQLite: true });
    reopened.load();
    assert.strictEqual(reopened.getEdge('alfa', 'beta', 'tür', 'w1').source, 'source-a');
    assert.strictEqual(reopened.getEdge('alfa', 'beta', 'tür', 'w2').source, 'source-b');
    reopened.close?.();
  });
});
