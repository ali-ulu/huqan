'use strict';

/**
 * #1213: dream() generated hypotheses from graph shape alone and never
 * consulted lib/type-lattice.js, so it proposed relationships the system's own
 * semantics rule out — and every one of them reaches a reviewer's queue as
 * `review`, so the cost is human attention, not just cycles.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const Kernel = require('../kernel');
const Dream = require('../dream');
const { pairMatchesDisjoint, registerDisjointPair, unregisterDisjointPair } = require('../lib/type-lattice');
const { isSymmetricRelation, nodesAreDisjoint } = require('../lib/dream-hypothesis-semantics');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-dream-semantics-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

/** The out-edge accessor dream() passes in, from its pre-built index. */
function edgesOf(kernel, workspaceId = 'default') {
  return nodeId => kernel.graph.getEdges(nodeId, workspaceId);
}

let seq = 0;
function makeKernel(edges, workspaceId = 'default') {
  seq += 1;
  const kernel = new Kernel({
    noLoad: true, loadPlugins: false, useSQLite: false,
    memoryPath: path.join(root, `k${seq}.json`),
  });
  for (const [from, to] of edges) {
    kernel.graph.addNode(from, from, null, { workspaceId });
    kernel.graph.addNode(to, to, null, { workspaceId });
    kernel.graph.addEdge(from, to, 'tür', { workspaceId, strength: 0.8, confidence: 0.9, source: 'manual' });
  }
  return kernel;
}

// The issue's graph: hayvan/bitki are the lattice's first disjoint pair, and
// both are siblings under canli.
const TAXONOMY = [
  ['kedi', 'hayvan'], ['kopek', 'hayvan'],
  ['gul', 'bitki'], ['lale', 'bitki'],
  ['hayvan', 'canli'], ['bitki', 'canli'],
];

describe('#1213 A: no similarity between types the lattice declares disjoint', () => {
  it('the reproduction no longer proposes hayvan ~ bitki', () => {
    assert.equal(pairMatchesDisjoint('hayvan', 'bitki'), true, 'precondition: the lattice says disjoint');

    const kernel = makeKernel(TAXONOMY);
    const result = kernel.selfEvolve({ workspaceId: 'default' });
    const proposals = [...result.addedDetails, ...result.deferredDetails];

    const disjointProposals = proposals.filter(p => pairMatchesDisjoint(p.from, p.to));
    assert.deepStrictEqual(disjointProposals, [], 'no proposal may join two disjoint types');
  });

  it('legitimate similarity between siblings is still proposed', () => {
    const hypotheses = new Dream(makeKernel(TAXONOMY)).dream({ workspaceId: 'default' });
    const pairs = hypotheses
      .filter(h => h.type === 'benzerlik' || h.type === 'vektör-benzerlik')
      .map(h => `${h.from}~${h.to}`);

    // The guard must not be a blanket suppression of the similarity rule.
    assert.ok(pairs.includes('kedi~kopek'), 'two animals are still similar');
    assert.ok(pairs.includes('gul~lale'), 'two plants are still similar');
    assert.ok(!pairs.includes('hayvan~bitki'));
  });

  it('disjointness is detected through ancestors, not just between the two ids', () => {
    const kernel = makeKernel(TAXONOMY);
    const cache = new Map();

    // Neither kedi nor gul appears in the disjoint table; their ancestors do.
    assert.equal(pairMatchesDisjoint('kedi', 'gul'), false);
    assert.equal(nodesAreDisjoint(edgesOf(kernel), 'kedi', 'gul', 'default', cache), true);

    assert.equal(nodesAreDisjoint(edgesOf(kernel), 'hayvan', 'bitki', 'default', cache), true, 'direct pair');
    assert.equal(nodesAreDisjoint(edgesOf(kernel), 'kedi', 'kopek', 'default', cache), false, 'siblings');
    assert.equal(nodesAreDisjoint(edgesOf(kernel), 'yok-1', 'yok-2', 'default', cache), false, 'unknown nodes');
  });

  it('the guard follows the workspace the pair was registered in (#1166)', () => {
    const kernel = makeKernel([['alfa', 'ustA'], ['beta', 'ustB']], 'tenant-a');
    const cache = () => new Map();

    assert.equal(nodesAreDisjoint(edgesOf(kernel, 'tenant-a'), 'alfa', 'beta', 'tenant-a', cache()), false);
    try {
      assert.equal(registerDisjointPair('ustA', 'ustB', 'tenant-a'), true);
      assert.equal(nodesAreDisjoint(edgesOf(kernel, 'tenant-a'), 'alfa', 'beta', 'tenant-a', cache()), true);
      // Another workspace never registered it.
      assert.equal(nodesAreDisjoint(edgesOf(kernel, 'tenant-b'), 'alfa', 'beta', 'tenant-b', cache()), false);
    } finally {
      unregisterDisjointPair('ustA', 'ustB', 'tenant-a');
    }
  });
});

describe('#1213 B: symmetry is proposed only for symmetric relations', () => {
  it('no simetri hypothesis inverts a tür edge', () => {
    const hypotheses = new Dream(makeKernel(TAXONOMY)).dream({ workspaceId: 'default' });
    const symmetry = hypotheses.filter(h => h.type === 'simetri');

    assert.deepStrictEqual(symmetry, [], 'tür is the only relation in this graph, and it is not symmetric');
  });

  it('a symmetric relation still gets its symmetry hypothesis', () => {
    seq += 1;
    const kernel = new Kernel({
      noLoad: true, loadPlugins: false, useSQLite: false,
      memoryPath: path.join(root, `sym${seq}.json`),
    });
    // Enough nodes for dream() to run, with one benzer edge whose reverse is
    // absent. The labels are real words because the node quality gate (#1643)
    // refuses single characters as hypothesis sources -- 'a'/'b'/'c' would be
    // filtered before this rule is ever reached, and the test would pass for
    // the wrong reason if it asserted emptiness instead.
    for (const id of ['elma', 'armut', 'erik']) kernel.graph.addNode(id, id, null, { workspaceId: 'default' });
    kernel.graph.addEdge('elma', 'armut', 'benzer', { workspaceId: 'default', strength: 0.9, confidence: 0.9, source: 'manual' });
    kernel.graph.addEdge('armut', 'erik', 'benzer', { workspaceId: 'default', strength: 0.9, confidence: 0.9, source: 'manual' });

    const symmetry = new Dream(kernel).dream({ workspaceId: 'default' }).filter(h => h.type === 'simetri');
    assert.ok(symmetry.length > 0, 'benzer is symmetric, so its reverse is a real hypothesis');
    assert.ok(symmetry.every(h => h.relation === 'benzer'));
  });

  it('the allowlist treats unknown relations as asymmetric', () => {
    assert.equal(isSymmetricRelation('benzer'), true);
    assert.equal(isSymmetricRelation('related_to'), true);

    for (const relation of ['tür', 'is_a', 'özellik', 'yapabilir', 'CAUSES', 'DEPENDS_ON', 'PREVENTS', 'içerir', 'uydurma', '', null, undefined]) {
      assert.equal(isSymmetricRelation(relation), false, `${String(relation)} must not be assumed symmetric`);
    }
  });

  it('a committed simetri hypothesis would have been a döngü contradiction', () => {
    // Why the rule matters: writing the reverse of a tür edge creates exactly
    // what verify's döngü rule reports.
    const kernel = makeKernel([['kedi', 'hayvan']]);
    kernel.graph.addEdge('hayvan', 'kedi', 'tür', { workspaceId: 'default', strength: 0.5, confidence: 0.5, source: 'manual' });

    const contradictions = kernel.detectContradictions('', 'default');
    assert.ok(contradictions.some(c => c.type === 'döngü'), 'the inverted tür edge is a contradiction');
  });
});
