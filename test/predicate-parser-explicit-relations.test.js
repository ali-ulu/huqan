'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeExplicitRelationObject, parseExplicitRelationPredicate, parsePredicate } = require('../lib/predicate-parser');

const normalizeWord = (value) => String(value || '').trim().toLowerCase();

test('empty explicit relation inputs do not invent an object or call the normalizer', () => {
  const unexpectedNormalization = () => assert.fail('empty input must not be normalized');
  for (const input of [undefined, null, '', '   ', '\t\n']) {
    assert.equal(normalizeExplicitRelationObject(input, {}, unexpectedNormalization), '');
    assert.equal(parseExplicitRelationPredicate(input, unexpectedNormalization), null);
  }
});

test('uppercase case endings normalize the exposed consonant while buffered stems stay intact', () => {
  for (const [input, expected] of [
    ['HASTALIGI', 'hastalik'],
    ['AHMEDI', 'ahmet'],
    ['KİTABI', 'ki̇tap'],
    ['ARABAYI', 'araba'],
  ]) {
    assert.equal(normalizeExplicitRelationObject(input, {}, normalizeWord), expected);
    assert.deepEqual(parseExplicitRelationPredicate(`${input} neden olur`, normalizeWord), {
      object: expected, relation: 'CAUSES',
    });
    assert.equal(normalizeExplicitRelationObject(input, { trimCaseSuffixes: false }, normalizeWord),
      normalizeWord(input));
  }
});

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
