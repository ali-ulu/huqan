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

test('a high-degree hub answer stays linear, not quadratic (#3909)', () => {
  const degree = 20000;
  const kernel = makeKernel('linear');
  try {
    seedHub(kernel, degree);
    const started = Date.now();
    const answer = kernel.ask('hub nedir');
    const elapsed = Date.now() - started;

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
    // The old array-dedup path took ~1.2 s at this degree on the same box; the
    // quadratic term is what this bounds. A generous ceiling still fails
    // loudly if either O(d^2) scan comes back.
    assert.ok(elapsed < 750, `hub answer took ${elapsed} ms at degree ${degree}; expected sub-second`);
  } finally {
    closeKernel(kernel);
  }
});

test('hub scaling is roughly linear in degree, not quadratic (#3909)', () => {
  const kernel = makeKernel('ratio');
  try {
    const timeAt = (degree) => {
      const k = makeKernel(`ratio-${degree}`);
      try {
        seedHub(k, degree);
        const started = Date.now();
        k.ask('hub nedir');
        return Date.now() - started;
      } finally {
        closeKernel(k);
      }
    };

    const small = Math.max(timeAt(4000), 1);
    const large = timeAt(32000);
    // 8x the degree. Linear would be ~8x; quadratic would be ~64x. A ceiling of
    // 20x leaves headroom for JIT/noise while still rejecting the old shape.
    assert.ok(large < small * 20, `8x degree grew work ${(large / small).toFixed(1)}x (${small} ms -> ${large} ms)`);
  } finally {
    closeKernel(kernel);
  }
});
