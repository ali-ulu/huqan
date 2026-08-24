const test = require('node:test');
const assert = require('node:assert/strict');

const createNlp = require('./index');

const cases = [
  {
    code: 'tr',
    sample: 'Kedi hayvandır',
    subject: 'kedi',
  },
  {
    code: 'en',
    sample: 'Cats are animals',
    subject: 'cat',
  },
  {
    code: 'de',
    sample: 'Katzen sind Tiere',
    subject: 'katzen',
  },
  {
    code: 'ar',
    sample: 'القط هو حيوان',
    subject: 'قط',
  },
];

for (const entry of cases) {
  test(`nlp pack ${entry.code} exposes the common interface`, () => {
    const nlp = createNlp(entry.code);
    assert.equal(typeof nlp.normalize, 'function');
    assert.equal(typeof nlp.tokenize, 'function');
    assert.equal(typeof nlp.isStopWord, 'function');
    assert.equal(typeof nlp.extractFacts, 'function');

    const facts = nlp.extractFacts(entry.sample);
    assert.ok(Array.isArray(facts));
    assert.ok(facts.length >= 1);
    assert.equal(nlp.normalize(entry.subject), entry.subject);
  });
}

/**
 * Packs whose copula is a separate word must keep a multi-word subject whole.
 *
 * The English pack searched for the copula *after* dropping stop-words, and
 * 'is'/'are'/'was'/'were' are themselves stop-words — so the copula was never
 * found, the branch was dead, and every sentence fell to a fallback that takes
 * the first non-stop-word as the subject. Single-word subjects came out right
 * by coincidence, which is what kept it hidden (#1037).
 *
 * Turkish is deliberately absent: its copula is a suffix ('hayvandır'), not a
 * word, so it does not have a copula index to split on.
 */
const copulaCases = [
  { code: 'en', sample: 'the big cat is a small animal', subject: 'big cat', predicate: 'small animal' },
  { code: 'de', sample: 'der grosse hund ist ein tier', subject: 'grosse hund', predicate: 'tier' },
  { code: 'ar', sample: 'القط الكبير هو حيوان صغير', subject: 'قط كبير', predicate: 'حيوان صغير' },
];

for (const entry of copulaCases) {
  test(`nlp pack ${entry.code} keeps a normalized multi-word subject across the copula (#1037, #1116)`, () => {
    const nlp = createNlp(entry.code);
    const facts = nlp.extractFacts(entry.sample);

    assert.equal(facts.length, 1, entry.sample);
    assert.equal(facts[0].subject, entry.subject, `${entry.code} subject`);
    assert.equal(facts[0].predicate, entry.predicate, `${entry.code} predicate`);
  });
}

test('nlp pack en resolves the copula branch rather than the fallback (#1037)', () => {
  const nlp = createNlp('en');
  // Every copula spelling must reach the branch, not just the present tense.
  for (const [sample, subject, predicate] of [
    ['cats are animals', 'cat', 'animals'],
    ['water is wet', 'water', 'wet'],
    ['the sky was blue', 'sky', 'blue'],
    ['the roads were wet', 'road', 'wet'],
  ]) {
    const facts = nlp.extractFacts(sample);
    assert.equal(facts.length, 1, sample);
    assert.equal(facts[0].subject, subject, sample);
    assert.equal(facts[0].predicate, predicate, sample);
  }

  // A sentence opening with the copula has no subject, so it yields nothing
  // rather than inventing one.
  assert.deepEqual(nlp.extractFacts('is a fragment'), []);
});
