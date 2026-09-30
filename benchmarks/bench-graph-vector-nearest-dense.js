'use strict';

// Run: node benchmarks/bench-graph-vector-nearest-dense.js
// Dense graph vectors (#3017 follow-up): every node carries one common tag, so
// the dimension index returns every node as a candidate. Compares the
// exhaustive cosine scan with the early-stopping exact top-1 lookup. The
// first lookup after a write also sorts the touched dimension lists; that
// cost is reported separately as sortMs.
const { createVectorIndex, rebuildVectorIndex, candidateIds } = require('../lib/graph-vector-index');
const { nearestSimilar } = require('../lib/graph-vector-nearest');
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
  nodes.gap = { id: 'gap', workspaceId: 'bench', vector: { common: 1, specific: 5 } };
  for (let i = 0; i < size - 2; i++) {
    const id = `other-${i}`;
    nodes[id] = { id, workspaceId: 'bench', vector: { common: 1, [`tag-${i % 500}`]: 1 + (i % 4) } };
  }
  nodes.match = { id: 'match', workspaceId: 'bench', vector: { common: 1, specific: 4 } };
  const index = createVectorIndex();
  rebuildVectorIndex(index, nodes);
  const getNode = (id) => nodes[id];
  const score = (id) => cosineSimilarity(getNode, 'gap', id, 'bench');
  const opts = { isEligible: (id) => id !== 'gap', rank: () => 0, score };

  const sortStart = process.hrtime.bigint();
  nearestSimilar(index, nodes, nodes.gap.vector, 'bench', opts);
  const sortMs = Number((Number(process.hrtime.bigint() - sortStart) / 1e6).toFixed(3));

  const baselineMs = measure(() => {
    let best = 0;
    for (const id of candidateIds(index, nodes, nodes.gap.vector, 'bench')) {
      if (id !== 'gap') best = Math.max(best, score(id));
    }
    return best;
  });
  let comparisons = 0;
  const counted = { ...opts, score: (id) => { comparisons++; return score(id); } };
  const nearestMs = measure(() => nearestSimilar(index, nodes, nodes.gap.vector, 'bench', counted));
  const result = nearestSimilar(index, nodes, nodes.gap.vector, 'bench', opts);
  console.log(JSON.stringify({ nodes: size, candidates: candidateIds(index, nodes, nodes.gap.vector, 'bench').length,
    baselineMs, nearestMs, sortMs, speedup: Number((baselineMs / nearestMs).toFixed(2)),
    comparisonsPerLookup: comparisons / 13, best: result.id }));
}
