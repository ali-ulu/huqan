const test = require('node:test');
const assert = require('node:assert/strict');

const ar = require('./lang-ar');

test('lang-ar normalize strips prefix and punctuation', () => {
  assert.equal(ar.normalize('القط!'), 'قط');
  assert.equal(ar.normalize('كتاب'), 'كتاب');
});

test('lang-ar extractFacts splits simple copula statements', () => {
  const facts = ar.extractFacts('القط هو حيوان');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].subject, 'قط');
  assert.equal(facts[0].predicate, 'حيوان');
});

test('lang-ar extractFacts preserves normalized multi-word subjects (#1116)', () => {
  assert.deepEqual(ar.extractFacts('مدينة برلين هي العاصمة'), [{
    subject: 'مدينة برلين',
    predicate: 'العاصمة',
  }]);
});

test('lang-ar extractFacts handles coordinated subjects', () => {
  const facts = ar.extractFacts('القط والكلب هو حيوان');
  assert.equal(facts.length, 2);
  assert.equal(facts[0].subject, 'قط');
  assert.equal(facts[1].subject, 'كلب');
  assert.equal(facts[0].predicate, 'حيوان');
});
