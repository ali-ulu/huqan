const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectRelationDrift } = require('../lib/relation-drift');

describe('relation-drift helper', () => {
  it('emits a review-only drift signal when differently related claims overlap topically', () => {
    const signal = detectRelationDrift(
      { text: 'TCAS detects traffic', subject: 'TCAS', relation: 'detects traffic' },
      { text: 'TCAS detects aircraft traffic', subject: 'TCAS', relation: 'detects aircraft traffic' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, 'PREDICATE_DRIFT');
    assert.strictEqual(signal.kind, 'risk');
    assert.ok(signal.flags.includes('RELATION_DRIFT'));
    assert.strictEqual(signal.meta.relationMismatch, true);
  });

  it('returns null for unrelated claims', () => {
    const signal = detectRelationDrift(
      { text: 'aspirin kan inceltici olarak etki eder', subject: 'aspirin', relation: 'etki eder' },
      { text: 'EDDF is in Frankfurt', subject: 'EDDF', relation: 'is in' },
    );

    assert.strictEqual(signal, null);
  });

  it('does not mistake a new predicate about a known subject for contradiction (#1076)', () => {
    const signal = detectRelationDrift(
      { text: 'kedi tür hayvan', subject: 'kedi', relation: 'tür' },
      { text: 'kedi uyuyor', subject: 'kedi', relation: 'uyuyor' },
    );

    assert.strictEqual(signal, null);
  });
});
