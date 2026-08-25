'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseExplicitRelationPredicate, parsePredicate } = require('../lib/predicate-parser');

const normalizeWord = (value) => String(value || '').trim().toLowerCase();

test('#1194 explicit relations preserve vowel-final noun objects', () => {
  for (const word of ['araba', 'hata', 'kapı', 'gürültü', 'masa', 'para', 'elma', 'ütü']) {
    assert.deepEqual(
      parseExplicitRelationPredicate(`${word} neden olur`, normalizeWord),
      { object: word, relation: 'CAUSES' },
      `${word} must not be shortened as if its final vowel were a case suffix`,
    );
  }
});

test('#1194 keeps buffered case normalization and does not devoice the exposed stem', () => {
  assert.deepEqual(
    parseExplicitRelationPredicate('arabayı neden olur', normalizeWord),
    { object: 'araba', relation: 'CAUSES' },
  );
  assert.deepEqual(
    parseExplicitRelationPredicate('kitabı neden olur', normalizeWord),
    { object: 'kitap', relation: 'CAUSES' },
  );
  assert.deepEqual(
    parseExplicitRelationPredicate('hastaligi neden olur', normalizeWord),
    { object: 'hastalik', relation: 'CAUSES' },
  );
});

test('#1194 does not classify the ambiguous `yapar` marker as CAUSES', () => {
  for (const word of ['spor', 'yemek', 'yazılım', 'temizlik', 'kanser']) {
    assert.equal(
      parseExplicitRelationPredicate(`${word} yapar`, normalizeWord),
      null,
      `${word} yapar must not be treated as an unqualified causal claim`,
    );
    assert.notEqual(parsePredicate(`${word} yapar`, normalizeWord).relation, 'CAUSES');
  }
});
