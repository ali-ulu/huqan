const test = require('node:test');
const assert = require('node:assert/strict');

const de = require('./lang-de');

test('lang-de normalize keeps umlauts and strips punctuation', () => {
  assert.equal(de.normalize('Katzen!'), 'katzen');
  assert.equal(de.normalize('Über'), 'über');
});

test('lang-de extractFacts splits simple copula statements', () => {
  const facts = de.extractFacts('Katzen sind Tiere');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].subject, 'katzen');
  assert.equal(facts[0].predicate, 'tiere');
});

test('lang-de extractFacts handles coordinated subjects', () => {
  const facts = de.extractFacts('Katzen und Hunde sind Säugetiere');
  assert.equal(facts.length, 2);
  assert.equal(facts[0].subject, 'katzen');
  assert.equal(facts[1].subject, 'hunde');
  assert.equal(facts[0].predicate, 'säugetiere');
});
