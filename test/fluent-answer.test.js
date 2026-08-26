'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeFluentAnswer, parseEvidence, renderTriple } = require('../lib/fluent-answer.js');

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

test('renderTriple: bilinen ilişki için doğal cümle üretir', () => {
  const s = renderTriple('provides', 'özellik', 'thread safety');
  assert.equal(s, 'provides, thread safety özelliğini sağlar.');
});

test('renderTriple: bilinmeyen ilişki için varsayılan kalıp kullanır', () => {
  const s = renderTriple('a', 'iliski-x', 'b');
  assert.equal(s, 'a — iliski-x: b.');
});

test('composeFluentAnswer: verified durumunda güven ifadesiyle açar', () => {
  const r = composeFluentAnswer({
    status: 'verified',
    confidence: 0.9,
    evidence: ['provides --[özellik]--> thread safety (relation=özellik, source=learn, confidence=0.90)'],
  }, 'What provides thread safety?');
  assert.match(r.answer, /doğrulayabiliyorum/);
  assert.match(r.answer, /özelliğini sağlar/);
  assert.equal(r.evidenceCount, 1);
});

test('composeFluentAnswer: kanıt yokken dürüst fallback üretir', () => {
  const r = composeFluentAnswer({ status: 'unknown', confidence: 0, evidence: [] }, 'xyz abc?');
  assert.match(r.answer, /karşılık bulamadım/);
  assert.equal(r.evidenceCount, 0);
});

test('composeFluentAnswer: kanıtsız contradicted çürütülmüş gibi sunulmaz (#1619)', () => {
  const r = composeFluentAnswer({ status: 'contradicted', confidence: 0.6, evidence: [] }, 'q');
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
