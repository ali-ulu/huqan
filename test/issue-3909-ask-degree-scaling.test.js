'use strict';

// #3909: `ask` was O(degree^2). `results`/`targets` were arrays deduplicated
// with `.includes()`, and `runAlternatives` scanned all edges with `.find()`
// for every target. A hub node answered in superlinear time -- 21 s at degree
// 100k, while a leaf stayed at 37 ms. This pins the shape of the fix: a hub
// answer must not blow up with degree, and the answer must stay correct.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');

function makeKernel(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-ask-degree-${label}-`));
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
}

function closeKernel(kernel) {
  kernel.graph.close();
  kernel.memory.close();
}

function seedHub(kernel, degree) {
  kernel.graph.addNode('hub', 'hub', null, { workspaceId: 'default' });
  for (let i = 0; i < degree; i += 1) {
    const id = `leaf${i}`;
    kernel.graph.addNode(id, id, null, { workspaceId: 'default' });
    kernel.graph.addEdge('hub', id, 'tür', { weight: 0.5 + i * 1e-7, workspaceId: 'default' });
  }
}

/**
 * Counts the edges `ask` reads, by wrapping the one graph method that
 * returns them. This is the work the fix was about, measured rather than
 * inferred: whatever statement an edge goes through, it is counted.
 */
function countEdgeVisits(kernel) {
  const counter = { edges: 0 };
  const original = kernel.graph.getEdges.bind(kernel.graph);
  kernel.graph.getEdges = (nodeId, workspaceId, options) => {
    const edges = original(nodeId, workspaceId, options);
    counter.edges += edges.length;
    return edges;
  };
  return counter;
}

test('a high-degree hub answer stays linear, not quadratic (#3909)', () => {
  const degree = 20000;
  const kernel = makeKernel('linear');
  try {
    seedHub(kernel, degree);
    const counter = countEdgeVisits(kernel);
    const answer = kernel.ask('hub nedir');

    assert.equal(answer.data.subject, 'hub');
    assert.equal(answer.data.unknown, false);
    // Every leaf must be present exactly once -- the Set dedup must not drop
    // or duplicate targets relative to the old array behaviour. Edges are
    // sorted by descending weight, and weight rises with index, so the first
    // target is the last leaf and the final target is leaf0.
    assert.match(answer.data.answer, new RegExp(`^hub leaf${degree - 1}, leaf${degree - 2},`));
    assert.match(answer.data.answer, /leaf0$/);
    const leafTokens = answer.data.answer.match(/leaf\d+/g) || [];
    assert.equal(leafTokens.length, degree, 'each of the degree targets appears once');
    assert.equal(new Set(leafTokens).size, degree, 'no duplicate targets in the answer');
    // The work is counted, not timed. The old path scanned the hub's edges
    // once per target -- O(d^2) edge reads -- and this bounds that directly:
    // a linear answer reads the hub's edges a small constant number of
    // times, and a quadratic one would read them degree times over.
    assert.ok(
      counter.edges < degree * 8,
      `hub answer read ${counter.edges} edges at degree ${degree}; the quadratic scan is back`,
    );
  } finally {
    closeKernel(kernel);
  }
});

test('hub scaling is linear in degree, not quadratic (#3909)', () => {
  const kernel = makeKernel('ratio');
  try {
    const edgesVisitedAt = (degree) => {
      const k = makeKernel(`ratio-${degree}`);
      try {
        seedHub(k, degree);
        const counter = countEdgeVisits(k);
        k.ask('hub nedir');
        return counter.edges;
      } finally {
        closeKernel(k);
      }
    };

    // 8x the degree. Linear reads ~8x the edges; quadratic would read ~64x.
    // A ceiling of 16x leaves room for the constant factors (a hub's own
    // edges are read twice -- once for the answer, once for the
    // alternatives) while still rejecting the old shape loudly.
    const small = edgesVisitedAt(4000);
    const large = edgesVisitedAt(32000);
    assert.ok(
      large < small * 16,
      `8x degree grew edge visits ${(large / small).toFixed(1)}x (${small} -> ${large}); the answer is no longer linear`,
    );
  } finally {
    closeKernel(kernel);
  }
});

test('the linear answer still takes sub-second time at high degree (#3909)', () => {
  // The wall-clock half of the original assertion, kept as a bound rather
  // than a ratio. A ratio of two single-shot timings is not a merge gate: a
  // shared CI runner is noisy enough that a fast small measurement and a
  // slow large one can read as superlinear on a linear implementation. The
  // edge-visit count above is the blocking signal; this is the one that
  // says the answer still arrives.
  const kernel = makeKernel('wallclock');
  try {
    const degree = 20000;
    const k = makeKernel('wallclock-measured');
    try {
      seedHub(k, degree);
      const started = Date.now();
      k.ask('hub nedir');
      const elapsed = Date.now() - started;
      // The old quadratic path took ~1.2 s at this degree on the same box.
      // A generous ceiling still fails loudly if the O(d^2) scan comes back.
      assert.ok(elapsed < 750, `hub answer took ${elapsed} ms at degree ${degree}; expected sub-second`);
    } finally {
      closeKernel(k);
    }
  } finally {
    closeKernel(kernel);
  }
});
