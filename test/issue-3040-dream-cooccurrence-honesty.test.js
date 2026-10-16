'use strict';

/**
 * #3040: the dream engine's `vektör-benzerlik` hypothesis is receipted as if it
 * were a semantic (embedding) similarity, but the graph's `vector` is just a
 * sparse tag counter: `Graph#addTag` does `v[dim] += weight`, and
 * `cosineSimilarity` runs over those counts. Two nodes that merely share
 * incidental tags therefore score high and the proposal reaches a reviewer's
 * queue labelled as a vector similarity.
 *
 * This pins the honest behaviour: the receipt must say the signal is
 * co-occurrence, not semantics, and two tag-sharing but otherwise unrelated
 * nodes must not carry a high vector-similarity confidence.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const Kernel = require('../kernel');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-dream-cooccurrence-'));
after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

let seq = 0;
function makeKernel() {
  seq += 1;
  return new Kernel({
    noLoad: true, loadPlugins: false, useSQLite: false,
    memoryPath: path.join(root, `k${seq}.json`),
  });
}

/**
 * Two nodes that share a pile of generic tags and nothing else. No type edges,
 * no shared neighbourhood, no relation: exactly the "common label files" case
 * the issue calls out. The tags are the only reason their cosine is high.
 */
const SHARED_TAGS = ['etiket-a', 'etiket-b', 'etiket-c', 'etiket-d', 'etiket-e'];

function makeTagSharingKernel() {
  const kernel = makeKernel();
  for (const id of ['kirmizi-elma', 'kirmizi-araba']) {
    kernel.graph.addNode(id, id, null, { workspaceId: 'default' });
    for (const tag of SHARED_TAGS) {
      kernel.graph.addTag(id, tag, 1.0, 'default');
    }
  }
  return kernel;
}

function dreamHypotheses(kernel) {
  const result = kernel.dream({ workspaceId: 'default' });
  const hypotheses = (result.data && result.data.hypotheses) || [];
  assert.ok(Array.isArray(hypotheses), 'dream must return a hypotheses array');
  return hypotheses;
}

describe('#3040 A: vector similarity is receipted as co-occurrence, not semantics', () => {
  it('the vektör-benzerlik hypothesis carries kind co-occurrence-similarity', () => {
    const hypotheses = dreamHypotheses(makeTagSharingKernel());

    const vectorHypotheses = hypotheses.filter(h => h.type === 'vektör-benzerlik');
    assert.ok(vectorHypotheses.length > 0, 'precondition: the tag-sharing pair must trigger the rule');

    for (const hypothesis of vectorHypotheses) {
      assert.equal(
        hypothesis.kind,
        'co-occurrence-similarity',
        'the hypothesis must declare its signal as co-occurrence, never semantic',
      );
      assert.equal(
        hypothesis.semantic,
        false,
        'the hypothesis must explicitly deny being semantic',
      );
      assert.equal(
        hypothesis._evidence.kind,
        'co-occurrence-similarity',
        'the receipt must carry the signal name, not the generic hypothesis kind',
      );
    }
  });

  it('two nodes that only share tags cannot reach a high confidence', () => {
    const hypotheses = dreamHypotheses(makeTagSharingKernel());

    const vectorHypotheses = hypotheses.filter(h => h.type === 'vektör-benzerlik');
    assert.ok(vectorHypotheses.length > 0);
    for (const hypothesis of vectorHypotheses) {
      assert.ok(
        hypothesis.confidence <= 0.3,
        `tag co-occurrence alone must stay low-confidence, got ${hypothesis.confidence}`,
      );
    }
  });
});
