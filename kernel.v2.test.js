const { describe, it } = require('node:test');
const assert = require('node:assert');
const KernelV2 = require('./kernel.v2');

function freshV2() {
  return new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false });
}

describe('KernelV2', () => {
  it('stores temporal metadata during learn', () => {
    const k = freshV2();
    const learnedAt = '2026-05-24T10:00:00.000Z';
    const res = k.learn('kedi hayvandir', { source: 'test-suite', learnedAt });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.meta.source, 'test-suite');
    const edge = k.kernel.graph.getEdge('kedi', 'hayvan', 'tür');
    assert.ok(edge);
    assert.strictEqual(edge.createdAt, learnedAt);
    assert.strictEqual(edge.updatedAt, learnedAt);
    assert.strictEqual(edge.source, 'test-suite');
    assert.ok(Array.isArray(edge.evidence));
  });

  it('verifies with type-chain inference when base returns unknown', () => {
    const k = freshV2();
    k.learn('kedi memelidir');
    k.learn('memeli canlidir');
    const res = k.verify('kedi canlidir');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.status, 'dogrulandi');
    if (Object.prototype.hasOwnProperty.call(res.data, 'inferred')) {
      assert.strictEqual(res.data.inferred, true);
    }
    assert.ok(Array.isArray(res.evidence));
    assert.ok(res.evidence.length >= 1);
  });

  it('verifies with multi-hop type-chain inference', () => {
    const k = freshV2();
    k.learn('kedi memelidir');
    k.learn('memeli hayvandir');
    k.learn('hayvan canlidir');
    const res = k.verify('kedi canlidir');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.status, 'dogrulandi');
    assert.ok(Array.isArray(res.evidence));
    if (Object.prototype.hasOwnProperty.call(res.data, 'inferred')) {
      assert.strictEqual(res.data.inferred, true);
      assert.ok(res.evidence.length >= 2);
      assert.strictEqual(res.data.pathLength >= 2, true);
      assert.strictEqual(res.data.confidenceSource, 'path-average');
      assert.ok(Array.isArray(res.data.reasoningPath));
    } else {
      assert.ok(res.evidence.length >= 1);
    }
  });

  it('returns contradiction for negated statement when positive chain exists', () => {
    const k = freshV2();
    k.learn('kedi memelidir');
    k.learn('memeli hayvandir');
    const res = k.verify('kedi hayvan degildir');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.status, 'celiski');
    assert.strictEqual(res.data.inferred, true);
    assert.strictEqual(res.data.contradictionReason, 'negated_statement_conflicts_with_type_chain');
    assert.ok(Array.isArray(res.evidence));
    assert.ok(res.evidence.length >= 1);
  });
});
