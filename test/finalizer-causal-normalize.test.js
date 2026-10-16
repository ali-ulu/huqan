'use strict';

// Characterises the causal normalisers moved out of finalizer.js (#2170):
// non-object items are dropped rather than coerced into empty records.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAffectedNode,
  normalizeCausalEvidence,
  normalizeCausalOutcome,
  normalizeCausalRisk,
} = require('../lib/finalizer-causal-normalize');

test('non-object outcomes, risks and affected nodes normalise to null', () => {
  for (const value of ['x', 7, null, undefined]) {
    assert.equal(normalizeCausalRisk(value), null, `risk ${String(value)}`);
    assert.equal(normalizeCausalOutcome(value), null, `outcome ${String(value)}`);
    assert.equal(normalizeAffectedNode(value), null, `node ${String(value)}`);
  }
});

test('a risk keeps its severity and falls back to empty chain and description', () => {
  assert.deepEqual(
    normalizeCausalRisk({ severity: 'high', impact: 0.5, confidence: 0.4, relation: 'CAUSES' }),
    { chain: [], severity: 'high', description: '' },
  );
});

test('causal evidence keeps objects, wraps strings and drops empties', () => {
  assert.deepEqual(normalizeCausalEvidence(['a', { text: 'b' }, null]), [{ type: 'text', value: 'a' }, { text: 'b' }]);
});
