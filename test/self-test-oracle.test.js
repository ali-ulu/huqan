const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyTestRisk,
  normalizeTestSuggestion,
  suggestRegressionTest,
} = require('../lib/self-test-oracle');

describe('self-test oracle', () => {
  it('classifies aviation claims as high-risk suggestions', () => {
    const risk = classifyTestRisk({ text: 'B737 has 4 engines' });

    assert.strictEqual(risk.domain, 'aviation');
    assert.ok(risk.highRisk);
    assert.ok(risk.flags.includes('HIGH_RISK_DOMAIN'));
  });

  it('flags absolute claims and keeps output suggest-only', () => {
    const suggestion = suggestRegressionTest({
      sourceClaim: 'the system always works',
    });

    assert.strictEqual(suggestion.canAutoWrite, false);
    assert.strictEqual(suggestion.action, 'suggest');
    assert.ok(suggestion.risk.flags.includes('ABSOLUTE_CLAIM'));
    assert.ok(suggestion.recommendedTestName.includes('absolute'));
  });

  it('normalizes the suggestion envelope deterministically', () => {
    const first = normalizeTestSuggestion({
      sourceClaim: 'According to React Native it is performant',
    });
    const second = normalizeTestSuggestion({
      sourceClaim: 'According to React Native it is performant',
    });

    assert.deepStrictEqual(first, second);
    assert.ok(first.suggestionId.startsWith('test-'));
    assert.ok(Array.isArray(first.warnings));
    assert.strictEqual(first.meta.classification, 'needs_review');
  });
});
