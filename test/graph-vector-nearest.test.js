'use strict';

// #3017 follow-up: the dimension index alone degrades to a full scan when a
// common tag puts every node in one bucket. nearestSimilarNode answers the
// gap lookup's exact top-1 cosine with an early stop instead; these tests pin
// that it returns exactly what the exhaustive scan returns (ties included).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { createDreamContext, findGapHypotheses } = require('../lib/dream-hypothesis-finders');

function withGraph(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  try {
    return fn(graph);
  } finally {
    graph.close?.();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function gapLookup(graph, gapId, { exhaustive = false } = {}) {
  const nodes = Object.values(graph.getNodes('ws'));
  const context = createDreamContext(graph, nodes, 'ws');
  const view = exhaustive
    ? Object.assign(Object.create(graph), { nearestSimilarNode: undefined, similarityCandidateIds: undefined })
    : graph;
  let comparisons = 0;
  const original = graph.cosineSimilarity.bind(graph);
  view.cosineSimilarity = (...args) => { comparisons++; return original(...args); };
  const hypotheses = [];
  findGapHypotheses({ detectGaps: () => [gapId] }, view, nodes, hypotheses, context);
  if (!exhaustive) delete view.cosineSimilarity;
  return { hypothesis: hypotheses[0] || null, comparisons };
}

test('nearest lookup matches the exhaustive scan on dense random graphs, ties included', () => {
  for (let seed = 1; seed <= 40; seed++) {
    withGraph('huqan-vector-nearest-', (graph) => {
      const random = seededRandom(seed);
      const dims = ['common', 'a', 'b', 'c', 'd', 'e'];
      for (let i = 0; i < 60; i++) {
        const id = `n${i}`;
        graph.addNode(id, id, null, { workspaceId: 'ws' });
        graph.addTag(id, 'common', 1, 'ws');
        for (const dim of dims.slice(1)) {
          // Small integer weights make exact cosine ties common.
          if (random() < 0.4) graph.addTag(id, dim, 1 + Math.floor(random() * 2), 'ws');
        }
      }
      for (let gap = 0; gap < 5; gap++) {
        const gapId = `n${gap}`;
        const indexed = gapLookup(graph, gapId);
        const exhaustive = gapLookup(graph, gapId, { exhaustive: true });
        assert.deepEqual(indexed.hypothesis, exhaustive.hypothesis, `seed ${seed} gap ${gapId}`);
      }
    });
  }
});

test('a tag shared by every node no longer forces a comparison with every node', () => {
  withGraph('huqan-vector-dense-', (graph) => {
    graph.addNode('gap', 'gap', null, { workspaceId: 'ws' });
    graph.addTag('gap', 'common', 1, 'ws');
    graph.addTag('gap', 'specific', 5, 'ws');
    for (let i = 0; i < 2000; i++) {
      graph.addNode(`other-${i}`, `other-${i}`, null, { workspaceId: 'ws' });
      graph.addTag(`other-${i}`, 'common', 1, 'ws');
      graph.addTag(`other-${i}`, `tag-${i}`, 3, 'ws');
    }
    graph.addNode('match', 'match', null, { workspaceId: 'ws' });
    graph.addTag('match', 'common', 1, 'ws');
    graph.addTag('match', 'specific', 5, 'ws');

    assert.equal(graph.similarityCandidateIds(graph.getNode('gap', 'ws').vector, 'ws').length, 2002,
      'the dimension index alone returns every node for this fixture');
    const indexed = gapLookup(graph, 'gap');
    const exhaustive = gapLookup(graph, 'gap', { exhaustive: true });
    assert.deepEqual(indexed.hypothesis, exhaustive.hypothesis);
    assert.equal(indexed.hypothesis.to, 'match');
    assert.ok(indexed.comparisons < 20, `expected an early stop, got ${indexed.comparisons} comparisons`);
    assert.equal(exhaustive.comparisons, 2001);
  });
});

test('nearest lookup follows tag writes and node removal', () => {
  withGraph('huqan-vector-nearest-write-', (graph) => {
    for (const id of ['gap', 'x', 'y']) graph.addNode(id, id, null, { workspaceId: 'ws' });
    graph.addTag('gap', 'p', 1, 'ws');
    graph.addTag('x', 'p', 1, 'ws');
    graph.addTag('x', 'q', 5, 'ws');
    graph.addTag('y', 'p', 1, 'ws');
    graph.addTag('y', 'r', 1, 'ws');
    assert.equal(gapLookup(graph, 'gap').hypothesis.to, 'y');
    // Raising y's unrelated dimension shrinks its normalized p weight: x wins.
    graph.addTag('y', 'r', 5, 'ws');
    assert.deepEqual(gapLookup(graph, 'gap').hypothesis, gapLookup(graph, 'gap', { exhaustive: true }).hypothesis);
    assert.equal(gapLookup(graph, 'gap').hypothesis.to, 'x');
    graph.removeNode('x', 'ws');
    assert.equal(gapLookup(graph, 'gap').hypothesis.to, 'y');
    graph.rebuildIndex();
    assert.equal(gapLookup(graph, 'gap').hypothesis.to, 'y');
  });
});

test('nearest lookup declines queries it cannot bound, so callers fall back', () => {
  withGraph('huqan-vector-nearest-decline-', (graph) => {
    graph.addNode('a', 'a', null, { workspaceId: 'ws' });
    graph.addTag('a', 'p', 1, 'ws');
    const always = { isEligible: () => true, rank: () => 0, score: () => 1 };
    assert.equal(graph.nearestSimilarNode({ p: -1 }, 'ws', always), null, 'negative query weight');
    assert.equal(graph.nearestSimilarNode({ p: Infinity }, 'ws', always), null, 'non-finite query');
    assert.deepEqual(graph.nearestSimilarNode({}, 'ws', always), { id: null, similarity: 0, aborted: false });
    graph.addNode('bad', 'bad', null, { workspaceId: 'ws' });
    graph.addTag('bad', 'p', Infinity, 'ws');
    assert.equal(graph.nearestSimilarNode({ p: 1 }, 'ws', always), null, 'unsafe workspace');
  });
});

test('nearest lookup stops when the caller runs out of comparison budget', () => {
  withGraph('huqan-vector-nearest-budget-', (graph) => {
    for (const id of ['a', 'b']) {
      graph.addNode(id, id, null, { workspaceId: 'ws' });
      graph.addTag(id, 'p', 1, 'ws');
    }
    const result = graph.nearestSimilarNode({ p: 1 }, 'ws',
      { isEligible: () => true, rank: () => 0, score: () => null });
    assert.deepEqual(result, { id: null, similarity: 0, aborted: true });
  });
});

test('a shrinking dimension refreshes the cached lists of the node\'s other dimensions', () => {
  withGraph('huqan-vector-nearest-stale-', (graph) => {
    for (const id of ['gap', 'x', 'y']) graph.addNode(id, id, null, { workspaceId: 'ws' });
    graph.addTag('gap', 'p', 1, 'ws');
    graph.addTag('x', 'p', 1, 'ws');
    graph.addTag('x', 'q', 5, 'ws');
    graph.addTag('y', 'p', 1, 'ws');
    graph.addTag('y', 'r', 1, 'ws');
    assert.equal(gapLookup(graph, 'gap').hypothesis.to, 'y');
    // x's q drops to zero: its normalized p weight rises from 0.196 to 1, so
    // a stale p list would rank it below y and stop before reaching it.
    graph.addTag('x', 'q', -5, 'ws');
    assert.equal(gapLookup(graph, 'gap').hypothesis.to, 'x');
  });
});

test('an unread node tying the best score at the bound still wins on rank', () => {
  withGraph('huqan-vector-nearest-tie-', (graph) => {
    // b enters the p bucket first, so the sorted list reads it before a.
    for (const id of ['b', 'a']) {
      graph.addNode(id, id, null, { workspaceId: 'ws' });
      graph.addTag(id, 'p', 1, 'ws');
    }
    const rank = { a: 0, b: 1 };
    const result = graph.nearestSimilarNode({ p: 1 }, 'ws', {
      isEligible: () => true,
      rank: (id) => rank[id],
      score: (id) => graph.getNode(id, 'ws').vector.p,
    });
    assert.deepEqual(result, { id: 'a', similarity: 1, aborted: false });
  });
});

test('an exhausted comparison budget ends the gap lookup on both the nearest and the scan path', () => {
  withGraph('huqan-vector-nearest-finder-budget-', (graph) => {
    for (const id of ['gap', 'neg', 'a', 'b']) graph.addNode(id, id, null, { workspaceId: 'ws' });
    graph.addTag('gap', 'p', 1, 'ws');
    // A negative weight is not boundable: this gap takes the scan fallback.
    graph.addTag('neg', 'p', -1, 'ws');
    for (const id of ['a', 'b']) graph.addTag(id, 'p', 1, 'ws');
    for (const gapId of ['gap', 'neg']) {
      const nodes = Object.values(graph.getNodes('ws'));
      const context = createDreamContext(graph, nodes, 'ws');
      context.comparisonsRemaining = 1;
      const hypotheses = [];
      findGapHypotheses({ detectGaps: () => [gapId, 'a'] }, graph, nodes, hypotheses, context);
      assert.deepEqual(hypotheses, [], `${gapId}: an aborted lookup proposes nothing`);
      assert.equal(context.comparisonsRemaining, 0, gapId);
    }
  });
});
