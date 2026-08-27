'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeFluentAnswer, parseEvidence, renderTriple, detectLocale, extractKeywordClaim, EVIDENCE_RE } = require('../lib/fluent-answer.js');

test('extractKeywordClaim: soru kelimelerini soyar', () => {
  assert.equal(extractKeywordClaim('What provides thread safety?'), 'provides thread safety');
  assert.equal(extractKeywordClaim('thread safety nedir?'), 'thread safety');
});

test('extractKeywordClaim: tum kelimeler stopword ise orijinali dondurur', () => {
  assert.equal(extractKeywordClaim('nedir?'), 'nedir');
});

test('parseEvidence: kanıt satırını üçlüye ayrıştırır', () => {
  const t = parseEvidence([
    'provides --[özellik]--> thread safety (relation=özellik, source=learn, confidence=0.90)',
  ]);
  assert.equal(t.length, 1);
  assert.equal(t[0].subject, 'provides');
  assert.equal(t[0].relationKey, 'özellik');
  assert.equal(t[0].object, 'thread safety');
  assert.equal(t[0].confidence, 0.9);
});

test('renderTriple: bilinen ilişki için doğal cümle üretir (tr)', () => {
  const s = renderTriple('provides', 'özellik', 'thread safety', 'tr');
  assert.equal(s, 'provides, thread safety özelliğini sağlar.');
});

test('renderTriple: İngilizce ilişki şablonu (en)', () => {
  const s = renderTriple('encapsulation', 'improves', 'maintainability', 'en');
  assert.equal(s, 'encapsulation improves maintainability.');
});

test('renderTriple: bilinmeyen ilişki için varsayılan kalıp kullanır', () => {
  const s = renderTriple('a', 'iliski-x', 'b', 'tr');
  assert.equal(s, 'a — iliski-x: b.');
});

test('detectLocale: Türkçe ipucuyla tr, aksi halde en', () => {
  assert.equal(detectLocale('thread safety nedir?'), 'tr');
  assert.equal(detectLocale('What provides thread safety?'), 'en');
});

test('composeFluentAnswer: verified durumunda güven ifadesiyle açar (tr otomatik)', () => {
  const r = composeFluentAnswer({
    status: 'verified',
    confidence: 0.9,
    evidence: ['provides --[özellik]--> thread safety (relation=özellik, source=learn, confidence=0.90)'],
  }, 'thread safety nedir?');
  assert.match(r.answer, /doğrulayabiliyorum/);
  assert.match(r.answer, /özelliğini sağlar/);
  assert.equal(r.evidenceCount, 1);
  assert.equal(r.lang, 'tr');
});

test('composeFluentAnswer: İngilizce soruda EN şablon seçer', () => {
  const r = composeFluentAnswer({
    status: 'verified',
    confidence: 0.9,
    evidence: ['encapsulation --[improves]--> code maintainability (relation=improves, source=learn, confidence=0.90)'],
  }, 'What improves code maintainability?');
  assert.equal(r.lang, 'en');
  assert.match(r.answer, /Verified against my graph/);
  assert.match(r.answer, /improves code maintainability\./);
});

test('composeFluentAnswer: lang opsiyonu algılamayı ezer', () => {
  const r = composeFluentAnswer({ status: 'unknown', confidence: 0, evidence: [] }, 'anything', { lang: 'en' });
  assert.match(r.answer, /could not find anything/);
  assert.equal(r.lang, 'en');
});

test('composeFluentAnswer: kanıt yokken dürüst fallback üretir', () => {
  const r = composeFluentAnswer({ status: 'unknown', confidence: 0, evidence: [] }, 'bu konu nedir?');
  assert.match(r.answer, /karşılık bulamadım/);
  assert.equal(r.evidenceCount, 0);
});

test('composeFluentAnswer: kanıtsız contradicted çürütülmüş gibi sunulmaz (#1619)', () => {
  const r = composeFluentAnswer({ status: 'contradicted', confidence: 0.6, evidence: [] }, 'q?', { lang: 'tr' });
  assert.match(r.answer, /bulamadım/);
  assert.doesNotMatch(r.answer, /çürüt/);
});

test('composeFluentAnswer: aynı üçlü tekrarı tekilleştirilir', () => {
  const ev = [
    'a --[özellik]--> b (relation=özellik, source=learn, confidence=0.9)',
    'a --[özellik]--> b (relation=özellik, source=learn, confidence=0.9)',
  ];
  const r = composeFluentAnswer({ status: 'unknown', confidence: 0.5, evidence: ev }, 'q');
  assert.equal(r.evidenceCount, 1);
});
