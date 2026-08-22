const assert = require('node:assert/strict');
const test = require('node:test');
const Kernel = require('../kernel');

function freshKernel() {
  return new Kernel({ noLoad: true });
}

function addEdge(kernel, from, to, relation, weight, extra = {}) {
  const edge = {
    from,
    to,
    relation,
    weight,
    confidence: weight,
    workspaceId: 'default',
    ...extra,
  };
  kernel.graph._edges.push(edge);
  return edge;
}

test('consolidate dry-run preserves edge array, identities, order, and details', () => {
  const kernel = freshKernel();
  const first = addEdge(kernel, 'a', 'b', 'supports', 0.9);
  const lowPair = addEdge(kernel, 'a', 'b', 'supports', 0.2);
  const highRelation = addEdge(kernel, 'a', 'c', 'supports', 0.8);
  const lowRelation = addEdge(kernel, 'a', 'd', 'supports', 0.1);
  const edgesBefore = kernel.graph._edges;
  const identitiesBefore = [...edgesBefore];

  const result = kernel.consolidate(true);

  assert.deepEqual(result, {
    dryRun: true,
    removed: 2,
    details: [
      'a → b (supports, w:0.2): low-weight (0.2) superseded by high-weight (0.9) for same pair',
      "a → d (supports, w:0.1): low-weight restriction (0.1) — subject already has high-weight 'supports'",
    ],
  });
  assert.strictEqual(kernel.graph._edges, edgesBefore);
  assert.deepEqual(kernel.graph._edges, identitiesBefore);
  assert.strictEqual(kernel.graph._edges[0], first);
  assert.strictEqual(kernel.graph._edges[1], lowPair);
  assert.strictEqual(kernel.graph._edges[2], highRelation);
  assert.strictEqual(kernel.graph._edges[3], lowRelation);
});

test('consolidate excludes restricted edges from both removal phases', () => {
  const kernel = freshKernel();
  const restrictedLow = addEdge(kernel, 'a', 'b', 'supports', 0.1, { kistlama: true });
  addEdge(kernel, 'a', 'b', 'supports', 0.9);
  addEdge(kernel, 'a', 'c', 'supports', 0.8);
  const unrestrictedLow = addEdge(kernel, 'a', 'd', 'supports', 0.1);

  const result = kernel.consolidate(true);

  assert.equal(result.removed, 1);
  assert.match(result.details[0], /a → d/);
  assert.ok(kernel.graph._edges.includes(restrictedLow));
  assert.ok(kernel.graph._edges.includes(unrestrictedLow));
});

test('consolidate non-dry run replaces edges, rebuilds once, saves once, and retains identities', () => {
  const kernel = freshKernel();
  const retained = addEdge(kernel, 'a', 'b', 'supports', 0.9);
  const removed = addEdge(kernel, 'a', 'b', 'supports', 0.2);
  const originalEdges = kernel.graph._edges;
  let rebuilds = 0;
  let saves = 0;
  const rebuildIndex = kernel.graph._rebuildIndex.bind(kernel.graph);
  kernel.graph._rebuildIndex = () => {
    rebuilds += 1;
    rebuildIndex();
  };
  kernel.graph.save = () => {
    saves += 1;
  };

  const result = kernel.consolidate(false);

  assert.equal(result.dryRun, false);
  assert.equal(result.removed, 1);
  assert.equal(rebuilds, 1);
  assert.equal(saves, 1);
  assert.notStrictEqual(kernel.graph._edges, originalEdges);
  assert.deepEqual(kernel.graph._edges, [retained]);
  assert.strictEqual(kernel.graph._edges[0], retained);
  assert.ok(!kernel.graph._edges.includes(removed));
});

test('consolidate with no removals does not rebuild or save', () => {
  const kernel = freshKernel();
  const retained = addEdge(kernel, 'a', 'b', 'supports', 0.9);
  let rebuilds = 0;
  let saves = 0;
  kernel.graph._rebuildIndex = () => { rebuilds += 1; };
  kernel.graph.save = () => { saves += 1; };

  const result = kernel.consolidate(false);

  assert.deepEqual(result, { dryRun: false, removed: 0, details: [] });
  assert.equal(rebuilds, 0);
  assert.equal(saves, 0);
  assert.strictEqual(kernel.graph._edges[0], retained);
});

test('consolidate preserves applied mutation when save throws', () => {
  const kernel = freshKernel();
  const retained = addEdge(kernel, 'a', 'b', 'supports', 0.9);
  addEdge(kernel, 'a', 'b', 'supports', 0.2);
  kernel.graph.save = () => {
    throw new Error('save failed');
  };

  assert.doesNotThrow(() => kernel.consolidate(false));
  assert.deepEqual(kernel.graph._edges, [retained]);
  assert.strictEqual(kernel.graph._edges[0], retained);
});
