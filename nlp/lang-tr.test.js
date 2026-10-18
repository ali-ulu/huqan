const test = require('node:test');
const assert = require('node:assert/strict');
const tr = require('./lang-tr');

test('lazy known nodes preserve object/array subject matching and longest prefix', () => {
  const cases = [
    ['New York City büyüktür', ['new york', 'NEW YORK CITY'], 'new york city'],
    ['Ali Yılmaz doktordur', { 'ALİ YILMAZ': { label: 'different label' } }, 'ali yilmaz'],
    ['Kırmızı Kedi sevimlidir', ['KIRMIZI KEDİ'], 'kirmizi kedi'],
  ];
  for (const [text, knownNodes, subject] of cases) {
    let reads = 0;
    const lazy = tr.extractFacts(text, () => { reads++; return knownNodes; });
    assert.deepEqual(lazy, tr.extractFacts(text, knownNodes));
    assert.equal(lazy[0].subject, subject);
    assert.equal(reads, 1, 'resolve once, not once per prefix');
  }
});

test('unambiguous Turkish extraction never resolves lazy known nodes', () => {
  for (const text of ['', 'kedi', 'kedi hayvandır', 'Ali Yılmaz bir doktordur', 'kedi ve köpek hayvandır']) {
    assert.deepEqual(tr.extractFacts(text, () => { throw new Error('unneeded graph read'); }),
      tr.extractFacts(text));
  }
});

test('lazy known nodes are fresh on every extraction and propagate necessary read failures', () => {
  let knownNodes = ['ali yilmaz'];
  const source = () => knownNodes;
  assert.equal(tr.extractFacts('Ali Yılmaz doktordur', source)[0].subject, 'ali yilmaz');
  knownNodes = [];
  assert.equal(tr.extractFacts('Ali Yılmaz doktordur', source)[0].subject, 'ali');
  assert.throws(() => tr.extractFacts('Ali Yılmaz doktordur', () => {
    throw new Error('known nodes unavailable');
  }), /known nodes unavailable/);
});

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

test('#1643 follow-up: punctuation debris tokens never become nodes', () => {
  // Markdown/JSON ingest sızıntısı: harf/rakam içermeyen token'lar
  assert.equal(tr.normalize('{'), '');
  assert.equal(tr.normalize('[],'), '');
  assert.equal(tr.normalize('---'), '');
  // Kenar noktalama temizlenir, içerik korunur
  assert.equal(tr.normalize('true,'), 'true');
  assert.equal(tr.normalize('"köpek"'), 'köpek');
  assert.equal(tr.normalize('availability.'), 'availability');
  // İç noktalama korunur (meşru tanımlayıcılar)
  assert.equal(tr.normalize('curl.exe'), 'curl.exe');
  assert.equal(tr.normalize('agent-card/exchange'), 'agent-card/exchange');
});

test('#1643 follow-up: extractFacts drops debris-only and debris-led lines', () => {
  // Tamamı gürültü → fact yok
  assert.deepEqual(tr.extractFacts('{ } [ ], ---'), []);
  // Gürültü ile başlayan satır → gürültü subject olamaz, sonraki kelime subject olur
  const facts = tr.extractFacts('{ output folders');
  for (const f of facts) {
    assert.match(f.subject, /[\p{L}\p{N}]/u, 'subject must carry lexical content');
  }
  // Meşru satır etkilenmez
  assert.deepEqual(tr.extractFacts('kedi süt içer'), [
    { subject: 'kedi', predicate: 'süt içer' },
  ]);
});
