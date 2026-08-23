const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ABSOLUTE_TERMS,
  HIGH_RISK_DOMAINS,
  RISK_RULES,
  detectAbsoluteClaim,
  detectHighRiskDomain,
  detectMultilingualAmbiguity,
  detectProvenanceMissing,
  detectRelationDrift,
  detectScopeExpansion,
  detectWeakPartialMatch,
  runRiskRules,
} = require('../lib/risk-rules');

describe('risk-rules', () => {
  it('detects weak partial match risk', () => {
    const signal = detectWeakPartialMatch({ confidence: 0.2, evidence: [] });
    assert.ok(signal);
    assert.strictEqual(signal.rule, RISK_RULES.WEAK_PARTIAL_MATCH);
  });

  it('detects high-risk aviation domain', () => {
    const signal = detectHighRiskDomain('B737 has 4 engines');
    assert.ok(signal);
    assert.strictEqual(signal.rule, RISK_RULES.HIGH_RISK_DOMAIN);
    assert.ok(signal.meta.domain);
  });

  it('detects absolute claims in English and Turkish', () => {
    for (const term of ['always', 'never', 'her zaman', 'asla', 'tüm']) {
      const signal = detectAbsoluteClaim(`This is ${term}`);
      assert.ok(signal, `expected absolute claim for ${term}`);
      assert.strictEqual(signal.rule, RISK_RULES.ABSOLUTE_CLAIM);
    }
    assert.ok(Array.isArray(ABSOLUTE_TERMS));
    assert.ok(HIGH_RISK_DOMAINS.aviation.length > 0);
  });

  it('does not flag an absolute term as a substring of an unrelated word (#1284)', () => {
    const cases = [
      'you should install this package',
      'this is a small ball we can throw',
      'the tumor and tumevarim topics are unrelated to absolutes',
    ];
    for (const text of cases) {
      assert.equal(detectAbsoluteClaim(text), null, text);
    }
  });

  it('does not flag a high-risk domain term as a substring of an unrelated word (#1284)', () => {
    // 'para' (financial domain) inside 'paragraf'/'paralel'.
    const signal = detectHighRiskDomain('read the paragraph carefully, it runs in parallel');
    assert.equal(signal, null);
  });

  it('still detects an absolute/domain term at a real word boundary next to punctuation (#1284)', () => {
    assert.ok(detectAbsoluteClaim('always, without exception, wins'));
    assert.ok(detectHighRiskDomain('(para) is the topic today'));
  });

  it('detects scope expansion', () => {
    const signal = detectScopeExpansion(
      { text: 'aşı bazı hastalıkları önlemeye yardımcı olabilir', subject: 'aşı' },
      { text: 'aşı tüm hastalıkları önler', subject: 'aşı' },
    );
    assert.ok(signal);
    assert.strictEqual(signal.rule, RISK_RULES.SCOPE_EXPANSION);
  });

  it('detects relation drift', () => {
    const signal = detectRelationDrift(
      { text: 'TCAS detects traffic', subject: 'TCAS', relation: 'detects traffic' },
      { text: 'TCAS is weather radar', subject: 'TCAS', relation: 'is weather radar' },
    );
    assert.ok(signal);
    assert.strictEqual(signal.rule, RISK_RULES.RELATION_DRIFT);
  });

  it('detects multilingual ambiguity', () => {
    const signal = detectMultilingualAmbiguity('was ist B737');
    assert.ok(signal);
    assert.strictEqual(signal.rule, RISK_RULES.MULTILINGUAL_AMBIGUITY);
  });

  it('detects missing provenance', () => {
    const signal = detectProvenanceMissing({ text: 'B737 has 2 engines' });
    assert.ok(signal);
    assert.strictEqual(signal.rule, RISK_RULES.PROVENANCE_MISSING);
  });

  it('runs risk rules as deterministic helpers', () => {
    const signals = runRiskRules(
      { text: 'B737 has 2 engines', subject: 'B737' },
      { match: { confidence: 0.2, evidence: [] } },
    );
    assert.ok(Array.isArray(signals));
  });
});
