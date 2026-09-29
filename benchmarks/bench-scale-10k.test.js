const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runBenchmarks, benchLearnCurve, seedGraph, parseArgs } = require('./bench-scale-10k');
const { checkScale } = require('./check-scale-10k');

describe('Scale benchmark (#3016)', () => {
  it('parses known fixtures and rejects unknown ones', () => {
    const { fixtures } = parseArgs(['--fixtures=scale-10k']);
    assert.deepStrictEqual(fixtures, [{ name: 'scale-10k', nodes: 10000 }]);
    assert.throws(() => parseArgs(['--fixtures=nope']), /Unknown fixture/);
  });

  it('measures a superlinear learn curve at small sizes', () => {
    const curve = benchLearnCurve([20, 40]);
    assert.strictEqual(curve.length, 2);
    for (const point of curve) {
      assert.ok(point.batchMs >= 0, `batchMs=${point.batchMs}`);
      assert.ok(point.perNodeMs > 0, `perNodeMs=${point.perNodeMs}`);
    }
  });

  it('runs a tiny end-to-end pass without dropping graph size', () => {
    const result = runBenchmarks({
      fixtures: [{ name: 'scale-tiny', nodes: 100 }],
      iterations: 1,
      learnSizes: [20],
    });
    const fixture = result.fixtures['scale-tiny'];
    assert.ok(fixture.nodes >= 100, `nodes=${fixture.nodes}`);
    assert.ok(fixture.edges >= 100, `edges=${fixture.edges}`);
    for (const field of ['seedMs', 'askMs', 'verifyMs', 'reasonMs', 'saveMs']) {
      assert.ok(fixture[field] >= 0, `${field}=${fixture[field]}`);
    }
    assert.ok(fixture.seedThroughputNodesPerSec > 0);
    assert.strictEqual(fixture.learnCurve.length, 1);
    assert.ok(Number.isFinite(fixture.heapDeltaMB));
  });

  it('gates shape as blocking and timing as advisory by default', () => {
    const shape = { nodes: 10000, edges: 10000 };
    const timing = { seedMs: 200, askMs: 5, verifyMs: 90, reasonMs: 7, saveMs: 500, heapDeltaMB: 20 };
    const baseline = { fixtures: { 'scale-10k': { ...shape, ...timing } } };
    const shrunk = { fixtures: { 'scale-10k': { ...timing, nodes: 9999, edges: 10000 } } };
    assert.ok(checkScale(baseline, shrunk).blockingFailures.length > 0);

    const slow = { fixtures: { 'scale-10k': { ...shape, ...timing, seedMs: 5000 } } };
    const advisory = checkScale(baseline, slow);
    assert.strictEqual(advisory.blockingFailures.length, 0);
    assert.ok(advisory.advisoryFailures.length > 0);
    assert.ok(checkScale(baseline, slow, { strictTiming: true }).blockingFailures.length > 0);
  });
});
