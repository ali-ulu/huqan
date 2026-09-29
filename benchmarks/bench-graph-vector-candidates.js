'use strict';

// Run: node benchmarks/bench-graph-vector-candidates.js
// Sparse graph vectors: compare an exhaustive cosine lookup with the
// maintained dimension index. Build cost is reported separately; production
// maintains the index incrementally on node/tag writes and rebuilds on load.
// Local Windows / Node 22 sample (2026-09-29): 10k lookup 43.397 -> 0.047 ms,
// 50k lookup 413.638 -> 0.008 ms; index rebuild 73.914 / 608.793 ms.
// This fixture has one true candidate; dense/common dimensions can still
// produce a linear candidate set, so these numbers are not a worst-case bound.
const { createVectorIndex, indexNode, candidateIds } = require('../lib/graph-vector-index');
const { cosineSimilarity } = require('../lib/graph-node-similarity');

function measure(fn) {
  for (let i = 0; i < 3; i++) fn();
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3));
}

for (const size of [10000, 50000]) {
  const nodes = {};
  nodes.gap = { id: 'gap', workspaceId: 'bench', vector: { shared: 1 } };
  for (let i = 0; i < size - 2; i++) {
    const id = `other-${i}`;
    nodes[id] = { id, workspaceId: 'bench', vector: { [`tag-${i}`]: 1 } };
  }
  nodes.match = { id: 'match', workspaceId: 'bench', vector: { shared: 1 } };
  const index = createVectorIndex();
  const buildMs = measure(() => {
    index.buckets.clear(); index.dimensions.clear(); index.unsafeWorkspaces.clear();
    for (const [key, node] of Object.entries(nodes)) indexNode(index, key, node);
  });
  const getNode = (id) => nodes[id];
  const baselineMs = measure(() => {
    let best = 0;
    for (const id of Object.keys(nodes)) {
      if (id !== 'gap') best = Math.max(best, cosineSimilarity(getNode, 'gap', id, 'bench'));
    }
    return best;
  });
  const indexedMs = measure(() => {
    let best = 0;
    for (const id of candidateIds(index, nodes, nodes.gap.vector, 'bench')) {
      if (id !== 'gap') best = Math.max(best, cosineSimilarity(getNode, 'gap', id, 'bench'));
    }
    return best;
  });
  console.log(JSON.stringify({ nodes: size, buildMs, baselineMs, indexedMs,
    speedup: Number((baselineMs / indexedMs).toFixed(2)), candidates: candidateIds(index, nodes, nodes.gap.vector, 'bench').length - 1 }));
}
