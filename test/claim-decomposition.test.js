const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  decomposeClaim,
  isCompoundClaim,
  normalizeDecomposition,
  normalizeSubclaim,
} = require('../lib/claim-decomposition');

describe('claim-decomposition', () => {
  it('keeps a single claim as non-compound', () => {
    const result = decomposeClaim('React Native is used in production');

    assert.strictEqual(result.compound, false);
    assert.strictEqual(result.subclaims.length, 1);
    assert.strictEqual(result.subclaims[0].claim, 'React Native is used in production');
    assert.strictEqual(isCompoundClaim('React Native is used in production'), false);
  });

  it('splits repeated-subject compound claims deterministically', () => {
    const result = decomposeClaim('React Native is used in production and React Native is performant');

    assert.strictEqual(result.compound, true);
    assert.strictEqual(result.subclaims.length, 2);
    assert.strictEqual(result.subclaims[0].claim, 'React Native is used in production');
    assert.strictEqual(result.subclaims[1].claim, 'React Native is performant');
    assert.strictEqual(result.subclaims[0].required, true);
    assert.strictEqual(result.subclaims[0].source, 'deterministic');
  });

  it('normalizes a bare second clause with the shared prefix', () => {
    const result = decomposeClaim('React Native is used in production and performant');

    assert.strictEqual(result.compound, true);
    assert.strictEqual(result.subclaims.length, 2);
    assert.ok(result.subclaims[1].claim.startsWith('React Native'));
  });

  it('normalizes subclaims and decomposition envelopes', () => {
    const normalized = normalizeSubclaim({
      claim: 'React Native is performant',
      subject: 'React Native',
      required: true,
    });
    const envelope = normalizeDecomposition({
      originalClaim: 'React Native is performant',
      compound: false,
      subclaims: [normalized],
      warnings: ['X'],
    });

    assert.strictEqual(normalized.subject, 'React Native');
    assert.strictEqual(envelope.originalClaim, 'React Native is performant');
    assert.strictEqual(envelope.subclaims.length, 1);
    assert.deepStrictEqual(envelope.warnings, ['X']);
  });
});
