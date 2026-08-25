const test = require('node:test');
const assert = require('node:assert/strict');
const tr = require('./lang-tr');

test('Turkish extraction retains a multi-word subject before bir (#1171)', () => {
  assert.deepEqual(tr.extractFacts('Ali Yılmaz bir doktordur'), [
    { subject: 'ali yilmaz', predicate: 'doktordur' },
  ]);
});

test('#1206 normalize strips guarded Turkish case suffixes', () => {
  const cases = [
    ['kedinin', 'kedi'],
    ['kediyi', 'kedi'],
    ['kediye', 'kedi'],
    ['kedide', 'kedi'],
    ['kediden', 'kedi'],
    ['kitaba', 'kitap'],
    ['kitabı', 'kitap'],
    ['ağacı', 'ağaç'],
    ['kitapları', 'kitap'],
  ];

  for (const [surface, expected] of cases) {
    assert.equal(tr.normalize(surface), expected, `${surface} should resolve to ${expected}`);
  }
});

test('#1206 leaves bare nouns and ambiguous short vowel endings intact', () => {
  for (const word of ['kedi', 'araba', 'hata', 'kalemi']) {
    assert.equal(tr.normalize(word), word, `${word} must not be shortened as a case form`);
  }
  assert.equal(tr.normalize('kırmızı'), 'kirmizi', 'the existing dotless-ı fold remains active');
  assert.equal(tr.normalize('kediler'), 'kedi', 'the existing plural rule remains active');
});

test('#1206 requires the matching case harmony and consonant alternation', () => {
  assert.equal(tr.normalize('kedinin'), 'kedi');
  assert.equal(tr.normalize('kitapta'), 'kitap');
  assert.equal(tr.normalize('kitapde'), 'kitapde');
  assert.equal(tr.normalize('kitaptan'), 'kitap');
  assert.equal(tr.normalize('kitapdan'), 'kitapdan');
});
