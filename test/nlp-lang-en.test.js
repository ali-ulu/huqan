'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const en = require('../nlp/lang-en');
const createNlp = require('../nlp/index');

describe('nlp/lang-en normalize', () => {
  it('folds accented Latin letters to their base form instead of deleting them (#443)', () => {
    // Pre-fix, the ASCII filter deleted any character outside [a-z0-9-]
    // outright, so accented letters vanished rather than being folded:
    // café -> caf, naïve -> nave, résumé -> rsum.
    assert.strictEqual(en.normalize('café'), 'cafe');
    assert.strictEqual(en.normalize('naïve'), 'naive');
    assert.strictEqual(en.normalize('résumé'), 'resume');
  });

  it('still strips a trailing plural/verb suffix after folding diacritics', () => {
    assert.strictEqual(en.normalize('running'), 'runn');
    // 'cafés' -> NFKD-folded to 'cafes', which (like the pre-existing,
    // unrelated 'boxes' -> 'box' behavior) matches the 'es' suffix before 's'.
    assert.strictEqual(en.normalize('cafés'), 'caf');
    assert.strictEqual(en.normalize('résumés'), 'resum');
  });

  it('plain ASCII words are unaffected', () => {
    assert.strictEqual(en.normalize('The'), 'the');
    assert.strictEqual(en.normalize('  Dogs  '), 'dog');
  });
});

describe('nlp/index detectLanguage', () => {
  it('detects each language from characteristic hint words', () => {
    const auto = createNlp('auto');
    assert.strictEqual(auto.detectLanguage('The cat is running with the dog'), 'en');
    assert.strictEqual(auto.detectLanguage('der Hund ist schön'), 'de');
    assert.strictEqual(auto.detectLanguage('هو في المنزل'), 'ar');
  });

  it('gives the same answer across repeated calls (hoisted hint sets are not mutated)', () => {
    const auto = createNlp('auto');
    const text = 'The cat is running with the dog';
    const first = auto.detectLanguage(text);
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual(auto.detectLanguage(text), first);
    }
  });
});
