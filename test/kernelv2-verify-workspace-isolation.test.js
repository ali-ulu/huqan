const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');

const BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

let tempDir;
let counter = 0;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v2-verify-'));
});

after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeV2(name) {
  const kernel = new Kernel({
    memoryPath: path.join(tempDir, `${name}-${counter++}.json`),
    useSQLite: false,
    noLoad: true,
    loadPlugins: false,
  });
  return { kernel, v2: new KernelV2({ kernel }) };
}

function edge(graph, from, to, relation, workspaceId, weight = 0.9) {
  graph.addNode(from, from, null, { workspaceId });
  graph.addNode(to, to, null, { workspaceId });
  graph.addEdge(from, to, relation, { workspaceId, weight, confidence: weight });
}

/** Every node/target named anywhere in a verify envelope's evidence. */
function evidenceTokens(result) {
  const items = Array.isArray(result?.evidence) ? result.evidence : [];
  const tokens = [];
  for (const item of items) {
    if (typeof item === 'string') { tokens.push(item); continue; }
    if (item?.text) tokens.push(item.text);
    for (const node of item?.nodes || []) tokens.push(node);
    for (const e of item?.edges || []) { tokens.push(e.from); tokens.push(e.to); }
  }
  return tokens.join(' | ');
}

describe('KernelV2 verification stays inside the requested workspace (#734)', () => {
  it('does not read a type chain that exists only in the default workspace', () => {
    const { kernel, v2 } = makeV2('type-chain');
    // kedi -> kus -> ucar lives only in `default`.
    edge(kernel.graph, 'kedi', 'kus', 'tür', 'default');
    edge(kernel.graph, 'kus', 'ucar', 'tür', 'default');
    // workspace-b knows the subject but nothing that supports the claim.
    kernel.graph.addNode('kedi', 'kedi', null, { workspaceId: 'workspace-b' });

    const scoped = v2.verify('kedi ucar', { workspaceId: 'workspace-b' });
    assert.notStrictEqual(scoped.data.status, 'verified',
      'default-workspace chain leaked into a workspace-b verification');
    assert.ok(!evidenceTokens(scoped).includes('kus'),
      `evidence names a default-workspace node: ${evidenceTokens(scoped)}`);

    // The same claim in `default` still resolves from that chain.
    const unscoped = v2.verify('kedi ucar', { workspaceId: 'default' });
    assert.strictEqual(unscoped.data.status, 'verified');
  });

  it('_inferTypeChain only walks the given workspace', () => {
    const { kernel, v2 } = makeV2('infer-chain');
    edge(kernel.graph, 'a', 'b', 'tür', 'default');
    edge(kernel.graph, 'b', 'c', 'tür', 'default');
    edge(kernel.graph, 'a', 'x', 'tür', 'w2');

    assert.ok(v2._inferTypeChain('a', 'c', 4, 'default'), 'default chain should resolve');
    assert.strictEqual(v2._inferTypeChain('a', 'c', 4, 'w2'), null, 'w2 has no such chain');
  });

  it('_collect* helpers read only the given workspace', () => {
    const { kernel, v2 } = makeV2('collect');
    edge(kernel.graph, 'kedi', 'hayvan', 'tür', 'default');
    edge(kernel.graph, 'kedi', 'ucar', 'yapabilir', 'default');
    edge(kernel.graph, 'kedi', 'bitki', 'tür', 'w2');
    edge(kernel.graph, 'kedi', 'yuzer', 'yapabilir', 'w2');

    assert.deepStrictEqual(v2._collectTypeTargets('kedi', 'default'), ['hayvan']);
    assert.deepStrictEqual(v2._collectTypeTargets('kedi', 'w2'), ['bitki']);

    const factsDefault = v2._collectFactTargets('kedi', 'default').map((f) => f.rawTarget);
    const factsW2 = v2._collectFactTargets('kedi', 'w2').map((f) => f.rawTarget);
    assert.deepStrictEqual(factsDefault, ['ucar']);
    assert.deepStrictEqual(factsW2, ['yuzer']);

    const predsW2 = v2._collectPredicateTargets('kedi', 'w2').map((p) => p.rawTarget).sort();
    assert.deepStrictEqual(predsW2, ['bitki', 'yuzer']);
  });

  it('evidence builders emit no edges from another workspace', () => {
    const { kernel, v2 } = makeV2('evidence');
    edge(kernel.graph, 'kedi', 'hayvan', 'tür', 'default');
    edge(kernel.graph, 'kedi', 'ucar', 'yapabilir', 'default');
    edge(kernel.graph, 'kedi', 'bitki', 'tür', 'w2');

    for (const builder of ['_buildDirectTypeEvidence', '_buildDirectFactEvidence', '_buildPredicateEvidence']) {
      const items = v2[builder]('kedi', 'w2');
      const text = items.map((item) => item.text).join(' | ');
      assert.ok(!text.includes('hayvan'), `${builder} leaked a default-workspace edge: ${text}`);
      assert.ok(!text.includes('ucar'), `${builder} leaked a default-workspace edge: ${text}`);
    }
  });

  it('mutually exclusive facts in two workspaces do not cross-contaminate', () => {
    const { kernel, v2 } = makeV2('exclusive');
    kernel.learn('kedi ucar', { ...BYPASS, workspaceId: 'default' });
    kernel.learn('kedi ucmaz', { ...BYPASS, workspaceId: 'workspace-b' });

    const inB = v2.verify('kedi ucar', { workspaceId: 'workspace-b' });
    const tokens = evidenceTokens(inB);
    assert.ok(!tokens.includes('hayvan'), `workspace-b verification cited default evidence: ${tokens}`);

    // Whatever verdict workspace-b reaches, it must not be justified by the
    // default workspace's supporting fact.
    if (inB.data.status === 'verified') {
      assert.ok(
        kernel.graph.getEdges('kedi', 'workspace-b').length > 0,
        'verified in workspace-b with no workspace-b edges at all',
      );
    }
  });

  it('type-lattice conflict detection is scoped to the request', () => {
    const { kernel, v2 } = makeV2('lattice');
    edge(kernel.graph, 'kedi', 'hayvan', 'tür', 'default');
    kernel.graph.addNode('kedi', 'kedi', null, { workspaceId: 'w2' });

    const details = v2._buildContradictionDetails(
      { subject: 'kedi', predicate: 'bitki', isNegated: false },
      'bitki',
      'bitki',
      { workspaceId: 'w2' },
    );
    if (details) {
      const text = JSON.stringify(details);
      assert.ok(!text.includes('hayvan'),
        `w2 contradiction details cited a default-workspace type: ${text}`);
    }
  });

  it('an unscoped verify still behaves as before', () => {
    const { kernel, v2 } = makeV2('unscoped');
    edge(kernel.graph, 'kedi', 'kus', 'tür', 'default');
    edge(kernel.graph, 'kus', 'ucar', 'tür', 'default');

    assert.strictEqual(v2.verify('kedi ucar').data.status, 'verified');
    assert.strictEqual(v2.verify('kedi ucar', {}).data.status, 'verified');
    assert.strictEqual(v2.verify('kedi ucar', { workspaceId: '  ' }).data.status, 'verified');
  });
});
