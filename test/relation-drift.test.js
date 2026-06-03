const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectRelationDrift } = require('../lib/relation-drift');

describe('relation-drift helper', () => {
  it('emits a deterministic relation drift signal', () => {
    const signal = detectRelationDrift(
      { text: 'TCAS detects traffic', subject: 'TCAS', relation: 'detects traffic' },
      { text: 'TCAS is weather radar', subject: 'TCAS', relation: 'is weather radar' },
    );

    assert.ok(signal);
    assert.strictEqual(signal.rule, 'PREDICATE_DRIFT');
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
});
