'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { containsWholeTerm, containsNormalizedTerm } = require('../lib/text-utils');

test('containsNormalizedTerm matches a slash-terminated path hint that a whole-term match never can', () => {
  assert.equal(containsNormalizedTerm('test/unit/gate.test.js', 'test/'), true);
  assert.equal(containsNormalizedTerm('.github/workflows/ci.yml', '.github/workflows/'), true);
  // A boundary is required on both sides for a whole term, and `/` is not a
  // word character, so the same hint can never match here.
  assert.equal(containsWholeTerm('test/unit/gate.test.js', 'test/'), false);
});

test('containsNormalizedTerm folds case and whitespace before matching', () => {
  assert.equal(containsNormalizedTerm('  Src/App.js ', 'src/'), true);
  assert.equal(containsNormalizedTerm('Memory/', 'memory/'), true);
});

test('containsNormalizedTerm fails closed on an empty or blank term', () => {
  assert.equal(containsNormalizedTerm('src/app.js', ''), false);
  assert.equal(containsNormalizedTerm('src/app.js', '   '), false);
  assert.equal(containsNormalizedTerm('', 'src/'), false);
});

test('containsNormalizedTerm is a plain substring, not a whole-term match', () => {
  // The content vocabulary relies on whole-term matching so `token` does not
  // fire inside `tokenizer`; the structural path vocabulary does not.
  assert.equal(containsNormalizedTerm('lib/tokenizer.js', 'token'), true);
  assert.equal(containsWholeTerm('lib/tokenizer.js', 'token'), false);
});
