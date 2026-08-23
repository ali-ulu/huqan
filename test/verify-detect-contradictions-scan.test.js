'use strict';

/**
 * Coverage for #395.
 *
 * detectContradictions ran five separate `for (const node of allNodes)` passes,
 * and each one called `graph.getEdges(node.id, scope)` for the same node --
 * O(5*N) graph reads on a path introspect() runs on every verify, and
 * autoThinkTick runs every third tick.
 *
 * Edges are now fetched once per node and shared across the passes. The passes
 * themselves stay separate, because the returned array is ordered by
 * contradiction type and fusing them into one node loop would reorder it.
 *
 * These tests pin both halves of that: the read count, and the output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const VerifyService = require('../lib/verify');

/**
 * Minimal graph double. Records every getEdges call so the scan count is
 * observable, which it is not through the real Graph.
 */
function fakeGraph(nodes, edgesByNode) {
  return {
    getEdgesCalls: [],
    getNodes() {
      return Object.fromEntries(nodes.map(id => [id, { id }]));
    },
    getEdges(nodeId) {
      this.getEdgesCalls.push(nodeId);
      return (edgesByNode[nodeId] || []).map(e => ({ from: nodeId, ...e }));
    },
    getEdge(from, to, relation) {
      return (edgesByNode[from] || [])
        .map(e => ({ from, ...e }))
        .find(e => e.to === to && e.relation === relation) || null;
    },
  };
}

function serviceFor(graph) {
  return new VerifyService({ graph });
}

test('each node is read exactly once, not once per detection pass (#395)', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  const graph = fakeGraph(nodes, {
    a: [{ to: 'x', relation: 'tür' }, { to: 'y', relation: 'tür' }],
    b: [{ to: 'z', relation: 'değil' }, { to: 'zyapabilir', relation: 'olur' }],
    c: [{ to: 'v', relation: 'olur', weight: 0.1 }],
    d: [],
  });

  serviceFor(graph).detectContradictions('', 'default');

  assert.equal(graph.getEdgesCalls.length, nodes.length);
  assert.deepEqual([...graph.getEdgesCalls].sort(), [...nodes].sort());
});

test('a subject filter reads only that node (#395)', () => {
  const graph = fakeGraph(['a', 'b', 'c'], {
    a: [{ to: 'hayvan', relation: 'tür' }, { to: 'bitki', relation: 'tür' }],
    b: [{ to: 'insan', relation: 'tür' }, { to: 'kurum', relation: 'tür' }],
    c: [],
  });

  const found = serviceFor(graph).detectContradictions('a', 'default');

  assert.deepEqual(graph.getEdgesCalls, ['a']);
  assert.equal(found.length, 1);
  assert.equal(found[0].node, 'a');
});

test('çoklu-tür is reported only for disjoint types', () => {
  const graph = fakeGraph(['a'], {
    a: [{ to: 'hayvan', relation: 'tür' }, { to: 'bitki', relation: 'tür' }],
  });
  const found = serviceFor(graph).detectContradictions();
  assert.equal(found.length, 1);
  assert.equal(found[0].type, 'çoklu-tür');
  assert.deepEqual(found[0].targets, ['hayvan', 'bitki']);
  assert.equal(found[0].confidence, 0.95);
});

test('compatible types are not reported as a contradiction (#1174)', () => {
  const graph = fakeGraph(['a'], {
    a: [{ to: 'doktor', relation: 'tür' }, { to: 'ebeveyn', relation: 'tür' }],
  });
  assert.deepEqual(serviceFor(graph).detectContradictions(), []);
});

test('döngü is reported once per node even with several back edges (#395)', () => {
  // The de-duplication used to be a linear rescan of the contradictions array;
  // it is now a set of node ids. Same contract: one 'döngü' entry per node.
  const graph = fakeGraph(['a', 'b'], {
    a: [{ to: 'b', relation: 'tür' }, { to: 'c', relation: 'tür' }],
    b: [{ to: 'a', relation: 'tür' }],
    c: [{ to: 'a', relation: 'tür' }],
  });

  const found = serviceFor(graph).detectContradictions();
  const cycles = found.filter(c => c.type === 'döngü');

  assert.equal(cycles.filter(c => c.node === 'a').length, 1);
  assert.equal(cycles.filter(c => c.node === 'b').length, 1);
});

test('düşük-ağırlık is still detected', () => {
  const graph = fakeGraph(['a'], {
    a: [{ to: 'x', relation: 'olur', weight: 0.1 }],
  });
  const found = serviceFor(graph).detectContradictions();
  assert.equal(found.length, 1);
  assert.equal(found[0].type, 'düşük-ağırlık');
});

test('time-series values are not reported as numeric contradictions (#1175)', () => {
  const graph = fakeGraph(['company'], {
    company: [
      { to: '2020 yılı çalışan sayısı 100', relation: 'özellik' },
      { to: '2021 yılı çalışan sayısı 120', relation: 'özellik' },
    ],
  });

  assert.deepEqual(serviceFor(graph).detectContradictions(), []);
});

test('different values under the same temporal qualifier remain numeric contradictions', () => {
  const graph = fakeGraph(['company'], {
    company: [
      { to: '2020 yılı çalışan sayısı 100', relation: 'özellik' },
      { to: '2020 yılı çalışan sayısı 120', relation: 'özellik' },
    ],
  });

  const numeric = serviceFor(graph).detectContradictions().filter(c => c.type === 'sayısal');
  assert.equal(numeric.length, 1);
});

test('results stay grouped by contradiction type, not by node (#395)', () => {
  // The passes were deliberately not fused into a single node loop, because
  // that would turn this type-major order into node-major order.
  const graph = fakeGraph(['a', 'b'], {
    a: [
      { to: 'hayvan', relation: 'tür' },
      { to: 'bitki', relation: 'tür' },
      { to: 'x', relation: 'olur', weight: 0.1 },
    ],
    b: [
      { to: 'insan', relation: 'tür' },
      { to: 'kurum', relation: 'tür' },
      { to: 'y', relation: 'olur', weight: 0.05 },
    ],
  });

  const types = serviceFor(graph).detectContradictions().map(c => c.type);

  // Both 'çoklu-tür' entries come before both 'düşük-ağırlık' entries.
  assert.deepEqual(types, ['çoklu-tür', 'çoklu-tür', 'düşük-ağırlık', 'düşük-ağırlık']);
});

test('an empty graph produces no contradictions and no reads', () => {
  const graph = fakeGraph([], {});
  assert.deepEqual(serviceFor(graph).detectContradictions(), []);
  assert.equal(graph.getEdgesCalls.length, 0);
});
