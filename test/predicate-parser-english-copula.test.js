'use strict';

/**
 * English copula in `learn:` predicates (#3643).
 *
 * "cats are animals" used to keep the copula inside the object, so the second
 * node was literally `are animals` and the edge was `özellik`. The predicate
 * parser now reads `X is/are Y` as a type statement: the copula is stripped, a
 * leading indefinite article goes with it, and the remainder becomes the
 * object of a `tür` relation -- the same relation the Turkish `-dir/-dır`
 * copula already produced. The two languages agree on the same fact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePredicate } = require('../lib/predicate-parser');

const NORMALIZE = (word) => String(word).toLowerCase();

test('"X are Y" is a type relation with the copula removed', () => {
  assert.deepEqual(parsePredicate('are animals', NORMALIZE), { object: 'animals', relation: 'tür' });
  assert.deepEqual(parsePredicate('are plants', NORMALIZE), { object: 'plants', relation: 'tür' });
});

test('"X is a Y" drops both the copula and the indefinite article', () => {
  assert.deepEqual(parsePredicate('is a mammal', NORMALIZE), { object: 'mammal', relation: 'tür' });
  assert.deepEqual(parsePredicate('is an animal', NORMALIZE), { object: 'animal', relation: 'tür' });
});

test('a longer English predicate keeps the noun phrase after the copula', () => {
  assert.deepEqual(
    parsePredicate('is a function that captures variables', NORMALIZE),
    { object: 'function that captures variables', relation: 'tür' },
  );
});

test('a location complement after the copula is not a type', () => {
  // "is inside the box" / "is outside the building" name a place, not a kind.
  // Recognizing only some prepositions let these slip into a `tür` edge.
  assert.deepEqual(parsePredicate('is inside the box', NORMALIZE), { object: 'is inside the box', relation: 'özellik' });
  assert.deepEqual(parsePredicate('is outside the building', NORMALIZE), { object: 'is outside the building', relation: 'özellik' });
});

test('a copula with no remainder is not treated as a type', () => {
  // "is" alone has nothing to name, so the copula rule must not fire; it
  // falls through to the generic predicate and never yields an empty object.
  assert.deepEqual(parsePredicate('is', NORMALIZE), { object: 'is', relation: 'özellik' });
});

test('the Turkish copula contract is unchanged', () => {
  assert.deepEqual(parsePredicate('doğru dönme yöntemidir', NORMALIZE), { object: 'doğru dönme yöntemi', relation: 'tür' });
  assert.deepEqual(parsePredicate('hissetmez', NORMALIZE), { object: 'hissetmez', relation: 'değil' });
});
