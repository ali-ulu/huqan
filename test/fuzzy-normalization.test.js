const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeFuzzyOverlap,
  meaningfulTokens,
  normalizeFuzzyText,
  tokenizeFuzzyText,
} = require('../lib/fuzzy-normalization');

describe('fuzzy-normalization', () => {
  it('normalizes stopword-heavy text without overclaiming overlap', () => {
    assert.strictEqual(normalizeFuzzyText('  TCAS is weather radar  '), 'tcas is weather radar');
    assert.deepStrictEqual(tokenizeFuzzyText('EDDF is in Paris'), ['eddf', 'is', 'in', 'paris']);
    assert.deepStrictEqual(meaningfulTokens('EDDF is in Paris'), ['eddf', 'paris']);
  });

  it('treats short stopword overlap as weak evidence', () => {
    const overlap = analyzeFuzzyOverlap('EDDF is in Frankfurt', 'EDDF is in Paris');
    assert.strictEqual(overlap.isWeak, true);
    assert.strictEqual(overlap.overlapCount, 1);
    assert.ok(overlap.leftTokens.includes('eddf'));
  });

  it('keeps aviation call-sign style tokens meaningful', () => {
    const overlap = analyzeFuzzyOverlap('B737 has 2 engines', 'B737 has 4 engines');
    assert.strictEqual(overlap.isWeak, false);
    assert.ok(overlap.overlap.includes('b737'));
  });
});
