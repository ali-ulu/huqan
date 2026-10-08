'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeTextPair, STEPS, FEATURE_SPEC_DIGEST } = require('../lib/semantic-model-text-features');
const pair = { stored: { text: 'Kapı açıktır.' }, incoming: { text: 'Kapı kapalıdır.' } };

test('text features retain direction, ignore supervision and have fixed Float32 shape', () => {
  const vector = encodeTextPair(pair);
  assert.ok(vector instanceof Float32Array);
  assert.equal(vector.length, STEPS);
  assert.ok(Array.from(vector).every(Number.isFinite));
  assert.deepEqual(vector, encodeTextPair({ ...pair, label: 'NEUTRAL', split: 'holdout', reviewerId: 'hidden' }));
  assert.notDeepEqual(vector, encodeTextPair({ stored: pair.incoming, incoming: pair.stored }));
  assert.match(FEATURE_SPEC_DIGEST, /^sha256:[a-f0-9]{64}$/);
});

test('Unicode normalization is stable and malformed or oversized text fails closed', () => {
  const composed = { stored: { text: 'Café açık.' }, incoming: { text: 'Café kapalı.' } };
  assert.deepEqual(encodeTextPair(composed), encodeTextPair({
    stored: { text: composed.stored.text.normalize('NFD') }, incoming: { text: composed.incoming.text.normalize('NFD') } }));
  for (const text of ['', ' ', null, 'a'.repeat(2049)]) {
    assert.throws(() => encodeTextPair({ stored: { text }, incoming: pair.incoming }), /semantic_text_invalid/);
  }
});
