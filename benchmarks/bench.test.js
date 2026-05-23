const { describe, it } = require('node:test');
const assert = require('node:assert');
const { loadFixture, runBenchmarks } = require('./bench');

describe('Benchmark fixtures', () => {
  it('loads deterministic fixture arrays', () => {
    assert(Array.isArray(loadFixture('small')));
    assert(Array.isArray(loadFixture('medium')));
    assert(Array.isArray(loadFixture('large')));
  });

  it('runs a quick benchmark pass', () => {
    const results = runBenchmarks({ fixtures: ['small'], iterations: 1 });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].label, 'small');
    assert.ok(results[0].learn.avgMs >= 0);
    assert.ok(results[0].ask.avgMs >= 0);
  });
});
