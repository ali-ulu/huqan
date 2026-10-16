const test = require('node:test');
const assert = require('node:assert/strict');

const en = require('./lang-en');

test('lang-en normalize strips plural and simple suffixes', () => {
  assert.equal(en.normalize('Cats'), 'cat');
  assert.equal(en.normalize('running'), 'runn');
});

test('lang-en extractFacts splits simple subject and predicate', () => {
  const facts = en.extractFacts('Cats are animals');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].subject, 'cat');
  assert.equal(facts[0].predicate, 'animals');
});

test('lang-en extractFacts preserves normalized multi-word subjects (#1116)', () => {
  assert.deepEqual(en.extractFacts('The big dogs are animals'), [{
    subject: 'big dog',
    predicate: 'animals',
  }]);
  assert.deepEqual(en.extractFacts('New York is a city'), [{
    subject: 'new york',
    predicate: 'city',
  }]);
});

test('lang-en extractFacts handles coordinated subjects', () => {
  const facts = en.extractFacts('Cats and dogs are mammals');
  assert.equal(facts.length, 2);
  assert.equal(facts[0].subject, 'cat');
  assert.equal(facts[1].subject, 'dog');
  assert.equal(facts[0].predicate, 'mammals');
});
