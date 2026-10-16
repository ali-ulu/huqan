const test = require('node:test');
const assert = require('node:assert/strict');

const createNlp = require('./index');

const cases = [
  {
    sample: 'Kedi hayvandır',
    subject: 'kedi',
  },
  {
    sample: 'Cats are animals',
    subject: 'cat',
  },
  {
    sample: 'Katzen sind Tiere',
    subject: 'katzen',
  },
  {
    sample: 'القط هو حيوان',
    subject: 'قط',
  },
];

for (const entry of cases) {
  test(`auto-detect extracts facts for: ${entry.sample}`, () => {
    const nlp = createNlp('auto');
    assert.equal(typeof nlp.detectLanguage, 'function');

    const lang = nlp.detectLanguage(entry.sample);
    assert.ok(['tr', 'en', 'de', 'ar'].includes(lang));

    const facts = nlp.extractFacts(entry.sample);
    assert.ok(Array.isArray(facts));
    assert.ok(facts.length >= 1);
    assert.equal(nlp.normalize(entry.subject), entry.subject);
  });
}

// Regression for #433: Turkish words that only use ö/ü (shared with German)
// must NOT be misdetected as German. German requires ä/ß or German hint words.
test('auto-detect does not misclassify Turkish ö/ü words as German (#433)', () => {
  const nlp = createNlp('auto');
  const turkishSharedOu = ['güneş', 'göz', 'üzüm', 'öğretmen', 'gül', 'önce'];
  for (const word of turkishSharedOu) {
    assert.equal(nlp.detectLanguage(word), 'tr', `expected '${word}' to be tr`);
  }
});

test('auto-detect still recognizes German via ä/ß and hint words', () => {
  const nlp = createNlp('auto');
  // ä and ß are German-specific
  assert.equal(nlp.detectLanguage('der Mann ist groß'), 'de');
  assert.equal(nlp.detectLanguage('über München älter'), 'de');
  // German hint words without ä/ß/ö/ü
  assert.equal(nlp.detectLanguage('der die das ist sind'), 'de');
});

test('auto-detect recognizes Turkish via ç/ğ/ı/ş and hint words', () => {
  const nlp = createNlp('auto');
  assert.equal(nlp.detectLanguage('çocuk şeker yiyor'), 'tr');
  assert.equal(nlp.detectLanguage('ve bir için gibi'), 'tr');
  assert.equal(nlp.detectLanguage('dur'), 'tr');
  assert.equal(nlp.detectLanguage('dür'), 'tr');
});

test('auto mode delegates normalization, tokenization, and stop words per language (#1115)', () => {
  const nlp = createNlp('auto');

  for (const word of ['the', 'is', 'are', 'of', 'and', 'with']) assert.equal(nlp.isStopWord(word), true, word);
  for (const word of ['der', 'die', 'das', 'und']) assert.equal(nlp.isStopWord(word), true, word);
  for (const word of ['في', 'من', 'على']) assert.equal(nlp.isStopWord(word), true, word);

  assert.deepEqual(nlp.tokenize('The cats are animals'), createNlp('en').tokenize('The cats are animals'));
  assert.deepEqual(nlp.tokenize('Der Hund ist groß'), createNlp('de').tokenize('Der Hund ist groß'));
  assert.equal(nlp.normalize('running', 'en'), createNlp('en').normalize('running'));
  assert.equal(nlp.normalize('Über', 'de'), createNlp('de').normalize('Über'));
});

test('language-pack lookup ignores inherited prototype keys (#1115)', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'bogus']) {
    const nlp = createNlp(key);
    assert.equal(nlp.name, 'turkish', key);
    assert.equal(typeof nlp.extractFacts, 'function', key);
  }
});
