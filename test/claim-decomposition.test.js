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

  it('uses the subject only when a trailing clause has its own predicate (#1117)', () => {
    for (const [claim, expected] of [
      ['Berlin has a river and is a capital', ['Berlin has a river', 'Berlin is a capital']],
      ['The dog has fleas and is sick', ['The dog has fleas', 'The dog is sick']],
      ['Ali can swim and is fast', ['Ali can swim', 'Ali is fast']],
      ['Redis is fast and has persistence', ['Redis is fast', 'Redis has persistence']],
    ]) {
      assert.deepEqual(decomposeClaim(claim).subclaims.map(item => item.claim), expected, claim);
    }
  });

  it('keeps carrying the first predicate when the trailing clause elides it (#1117)', () => {
    assert.deepEqual(
      decomposeClaim('Berlin has a river and a park').subclaims.map(item => item.claim),
      ['Berlin has a river', 'Berlin has a park'],
    );
    assert.deepEqual(
      decomposeClaim('Redis is fast and reliable').subclaims.map(item => item.claim),
      ['Redis is fast', 'Redis is reliable'],
    );
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

  it('marker matching is independent across repeated calls, even interleaved (#447)', () => {
    // A shared RegExp with a global/sticky flag advances .lastIndex as a side
    // effect of .test()/.match(), so a later call's result would silently
    // depend on where a previous, unrelated call left off. Decomposition
    // must not have that kind of cross-call state: the same claim must infer
    // the same subject/predicate no matter what was decomposed just before
    // it, and interleaving different claims must not perturb either one.
    const claimA = 'React Native is used in production';
    const claimB = 'Kubernetes kullanılır in every cluster';

    const first = decomposeClaim(claimA);
    for (let i = 0; i < 5; i += 1) {
      decomposeClaim(claimB);
      const repeat = decomposeClaim(claimA);
      assert.deepStrictEqual(repeat.subclaims[0].claim, first.subclaims[0].claim);
      assert.deepStrictEqual(repeat.subclaims[0].subject, first.subclaims[0].subject);
      assert.deepStrictEqual(repeat.subclaims[0].predicate, first.subclaims[0].predicate);
    }
  });
});
