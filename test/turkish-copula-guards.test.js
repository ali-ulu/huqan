'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { stripCopula } = require('../lib/turkish-copula');
const { parsePredicate } = require('../lib/predicate-parser');
const { normalizeText } = require('../lib/text-utils');
const { stripCopulaSuffix, foldTurkishAscii } = require('../lib/verify-native');

const normalizeWord = (value) => String(value || '').trim().toLowerCase();

// Words that really do carry a copula, with the stem each must leave behind.
// They span all eight vowel-harmony variants, so a table that drops one -- the
// defect in #1195 -- fails here rather than in production.
const REAL_COPULAS = [
  ['kitaptır', 'kitap'],
  ['sıcaktır', 'sıcak'],
  ['büyüktür', 'büyük'],
  ['soğuktur', 'soğuk'],
  ['doktordur', 'doktor'],
  ['müdürdür', 'müdür'],
  ['kötüdür', 'kötü'],
  ['yorgundur', 'yorgun'],
  ['yönetmendir', 'yönetmen'],
];

// Ordinary words whose last three letters merely look like a copula. Stripping
// any of them is the defect: several land on a *different real word*.
const FALSE_COPULAS = [
  ['kültür', 'culture -- the stem kül means ash, a different real word'],
  ['müdür', 'manager -- the stem mü is the question particle'],
  ['tür', 'type -- stripping leaves the empty string'],
  ['nadir', 'rare'],
  ['kadir', 'a name'],
  ['çadır', 'tent'],
  ['budur', '"this is it" -- the stem bu is a different word'],
  ['kül', 'ash -- no copula at all'],
];

test('#1195 stripCopula removes a real copula in all eight harmony variants', () => {
  for (const [word, stem] of REAL_COPULAS) {
    assert.equal(stripCopula(word), stem, `${word} must reduce to ${stem}`);
  }
});

test('#1106 stripCopula refuses words that only look like they carry one', () => {
  for (const [word, why] of FALSE_COPULAS) {
    assert.equal(stripCopula(word), null, `${word} must be left alone (${why})`);
  }
});

test('the minimum-stem rule is a deliberate trade, and it costs two-letter nouns', () => {
  // Documented cost of MIN_STEM_LENGTH: these carry a real copula and are left
  // alone anyway, because admitting them would also admit `müdür -> mü`. Pinned
  // so the trade is visible if someone later lowers the bound -- the failure
  // this buys is a missed match, never a fabricated node.
  for (const word of ['sudur', 'evdir', 'aydır']) {
    assert.equal(stripCopula(word), null, `${word} is knowingly left unstripped`);
  }

  // And the reason the bound cannot simply be lowered to two.
  assert.equal(stripCopula('müdür'), null);
  assert.equal(stripCopula('çadır'), null);
});

test('#1195 every copula variant parses to the tür relation, none to yapabilir', () => {
  for (const [word, stem] of REAL_COPULAS) {
    assert.deepEqual(
      parsePredicate(word, normalizeWord),
      { object: stem, relation: 'tür' },
      `${word} is a type claim, not a capability claim`,
    );
  }

  // The antonym pair that the missing variants used to split across two
  // relations, which defeated the opposite-predicate contradiction check
  // registered for exactly this pair in lib/kernel-v2-native.js.
  assert.equal(parsePredicate('sıcaktır', normalizeWord).relation, 'tür');
  assert.equal(parsePredicate('soğuktur', normalizeWord).relation, 'tür');
});

test('#1195 a false copula keeps its whole word as the object', () => {
  for (const [word] of FALSE_COPULAS) {
    const parsed = parsePredicate(word, normalizeWord);
    assert.equal(
      parsed.object,
      word,
      `${word} must not be truncated into a node id the user never named`,
    );
    assert.notEqual(parsed.object, '', 'no edge may point at the empty string');
  }
});

test('#1195 a multi-word predicate still drops only the copula', () => {
  assert.deepEqual(
    parsePredicate('doğru dönme yöntemidir', normalizeWord),
    { object: 'doğru dönme yöntemi', relation: 'tür' },
  );
});

test('#1106 stripCopulaSuffix stops collapsing distinct words onto one token', () => {
  const normalize = (value) => stripCopulaSuffix(foldTurkishAscii(value));

  // The collisions: each pair is two unrelated words that used to normalize to
  // the same token and therefore compared equal through phraseMatches.
  for (const [left, right] of [['kültür', 'kül'], ['müdür', 'mü'], ['nadir', 'na'], ['budur', 'bu']]) {
    assert.notEqual(
      normalize(left),
      normalize(right),
      `${left} and ${right} are different words and must not share a token`,
    );
  }

  assert.notEqual(normalize('tür'), '', 'tür must not normalize to the empty string');

  // The intended behaviour is untouched: a genuine copula is still removed, so
  // a claim and the stored fact it restates still match.
  assert.equal(normalize('yönetmendir'), normalize('yönetmen'));
  assert.equal(normalize('ateş kitaptır'), normalize('ateş kitap'));
});

test('#1167 a false copula no longer makes a claim match an unrelated stored type', () => {
  const KernelV2 = require('../kernel.v2');
  const kernel = new KernelV2();

  // The reported shape: with `kül --tür--> madde` in the graph, "Soba kültür"
  // verified at 0.95 because kültür and kül normalized to the same predicate
  // token.
  assert.notEqual(
    kernel._normalizePredicateToken('kültür'),
    kernel._normalizePredicateToken('kül'),
  );

  // A real copula still normalizes onto its stem, which is what lets
  // "X bir kitaptır" match a stored `kitap` type.
  assert.equal(
    kernel._normalizePredicateToken('kitaptır'),
    kernel._normalizePredicateToken('kitap'),
  );
});

test('#1196 normalizeText folds dotless ı so case no longer changes the token', () => {
  for (const word of ['kırmızı', 'ışık', 'ılık', 'sıcak', 'açık']) {
    assert.equal(
      normalizeText(word),
      normalizeText(word.toLocaleUpperCase('tr')),
      `${word} must produce one token in either case`,
    );
    assert.equal(normalizeText(word), normalizeText(word.toUpperCase()));
  }

  // All four spellings of the letter converge, which is the point: `İ` and `I`
  // already folded to `i`, and `ı` now joins them.
  assert.equal(normalizeText('ı'), 'i');
  assert.equal(normalizeText('İ'), 'i');
  assert.equal(normalizeText('I'), 'i');

  // Words that differ by more than case still differ.
  assert.notEqual(normalizeText('kırmızı'), normalizeText('yeşil'));
});
