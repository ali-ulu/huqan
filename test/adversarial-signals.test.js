const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ADVERSARIAL_RULES,
  detectAliasNormalization,
  detectDoubleNegation,
  detectStrawmanAttribution,
  detectWeaselWords,
  normalizeAliasText,
} = require('../lib/adversarial-signals');

describe('adversarial-signals', () => {
  it('detects double negation deterministically', () => {
    const signal = detectDoubleNegation('B737 is not not aircraft');
    assert.ok(signal);
    assert.strictEqual(signal.rule, ADVERSARIAL_RULES.DOUBLE_NEGATION);
  });

  it('detects weasel words in Turkish and English', () => {
    const turkish = detectWeaselWords('aspirin genellikle güvenlidir');
    const english = detectWeaselWords('this is usually safe');
    assert.ok(turkish);
    assert.ok(english);
    assert.strictEqual(turkish.rule, ADVERSARIAL_RULES.WEASEL_WORDS);
    assert.strictEqual(english.rule, ADVERSARIAL_RULES.WEASEL_WORDS);
  });

  it('detects strawman attribution framing', () => {
    const signal = detectStrawmanAttribution('Ali dedi ki B737 has 4 engines');
    assert.ok(signal);
    assert.strictEqual(signal.rule, ADVERSARIAL_RULES.STRAWMAN_ATTRIBUTION);
  });

  it('normalizes common aliases conservatively', () => {
    assert.strictEqual(normalizeAliasText('RN is React Native'), 'react native is react native');
    const signal = detectAliasNormalization('RN is React Native');
    assert.ok(signal);
    assert.strictEqual(signal.rule, ADVERSARIAL_RULES.ALIAS_NORMALIZATION);
  });
});
