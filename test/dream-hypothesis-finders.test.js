'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDreamContext, findGapHypotheses } = require('../lib/dream-hypothesis-finders');

// A graph stub with no edges, only the reads the gap finder makes.
function stubGraph(similarities, knownIds) {
  return {
    getEdges: () => [],
    getInEdges: () => [],
    getNode: (id) => (knownIds.includes(id) ? { id } : undefined),
    cosineSimilarity: (a, b) => similarities[`${a}~${b}`] ?? 0,
  };
}

function runGapFinder({ gaps, similarities, nodeIds, knownIds = nodeIds }) {
  const graph = stubGraph(similarities, knownIds);
  const kernel = { detectGaps: () => gaps };
  const nodes = nodeIds.map(id => ({ id }));
  const context = createDreamContext(graph, nodes, 'ws-gap');
  const hypotheses = [];
  findGapHypotheses(kernel, graph, nodes, hypotheses, context);
  return { hypotheses, context };
}

describe('dream gap hypotheses (#2120 split characterisation)', () => {
  it('proposes a link from a gap to its most similar node', () => {
    const { hypotheses } = runGapFinder({
      gaps: ['yalnız'],
      nodeIds: ['yalnız', 'kedi', 'köpek'],
      similarities: { 'yalnız~kedi': 0.2, 'yalnız~köpek': 0.6 },
    });
    assert.deepEqual(hypotheses, [{
      type: 'bağlantı-önerisi',
      from: 'yalnız',
      to: 'köpek',
      confidence: 0.3,
      benzerlik: 0.6,
    }]);
  });

  it('proposes nothing when the best similarity is at or below 0.1', () => {
    const { hypotheses } = runGapFinder({
      gaps: ['yalnız'],
      nodeIds: ['yalnız', 'kedi'],
      similarities: { 'yalnız~kedi': 0.1 },
    });
    assert.deepEqual(hypotheses, []);
  });

  it('skips a gap id that is not a node in the workspace', () => {
    const { hypotheses } = runGapFinder({
      gaps: ['hayalet'],
      nodeIds: ['kedi', 'köpek'],
      similarities: { 'hayalet~kedi': 0.9 },
    });
    assert.deepEqual(hypotheses, []);
  });

  it('spends one comparison per candidate from the shared budget', () => {
    const { context } = runGapFinder({
      gaps: ['yalnız'],
      nodeIds: ['yalnız', 'kedi', 'köpek'],
      similarities: {},
    });
    assert.equal(context.comparisonsRemaining, 10_000 - 2);
    assert.equal(context.workRemaining, 50_000 - 2);
  });
});
