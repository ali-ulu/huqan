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
