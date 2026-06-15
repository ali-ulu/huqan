const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SEMANTIC_THRESHOLDS,
  attachSemanticMeta,
  buildContradictionScore,
  buildRiskScore,
  buildSupportScore,
  classifySemanticTrust,
  normalizeSemanticClassification,
} = require('../lib/semantic-score');
const { runContradictionRules } = require('../lib/contradiction-rules');
const { runRiskRules } = require('../lib/risk-rules');

describe('semantic-score', () => {
  it('classifies strong support as dogrulandi', () => {
    const result = classifySemanticTrust({
      supportScore: 0.9,
      contradictionScore: 0,
      riskScore: 0.1,
      signals: [],
      evidence: [{ text: 'B737 has 2 engines' }],
    });

    assert.strictEqual(result.status, 'dogrulandi');
    assert.strictEqual(result.classification, 'verified');
    assert.ok(Array.isArray(result.warnings));
    assert.ok(Array.isArray(result.risk.flags));
    assert.ok(Array.isArray(result.signals));
    assert.ok(result.meta && typeof result.meta === 'object');
  });

  it('classifies strong contradiction as celiski', () => {
    const signals = runContradictionRules(
      { text: 'B737 has 2 engines', subject: 'B737' },
      { text: 'B737 has 4 engines', subject: 'B737' },
    );
    const result = classifySemanticTrust({
      supportScore: 0.2,
      contradictionScore: 0.8,
      riskScore: 0.5,
      signals,
    });

    assert.strictEqual(result.status, 'celiski');
    assert.strictEqual(result.classification, 'contradicted');
    assert.ok(result.risk.flags.length >= 1);
  });

  it('classifies weak support as bilinmiyor', () => {
    const result = classifySemanticTrust({
      supportScore: 0.35,
      contradictionScore: 0,
      riskScore: 0.2,
      signals: [],
    });

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.ok(['weak_match', 'unsupported', 'needs_review'].includes(result.classification));
  });

  it('classifies high-risk weak partial match as bilinmiyor', () => {
    const signals = runRiskRules(
      { text: 'B737 has 2 engines', subject: 'B737' },
      {
        match: { confidence: 0.45, evidence: [{ text: 'B737 has 2 engines' }] },
        domain: 'aviation',
      },
    );
    const result = classifySemanticTrust({
      supportScore: 0.45,
      contradictionScore: 0,
      riskScore: 0.7,
      signals,
      risk: { domain: 'aviation', flags: ['HIGH_RISK_DOMAIN', 'WEAK_PARTIAL_MATCH'] },
    });

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.ok(['needs_review', 'weak_match'].includes(result.classification));
    assert.ok(result.risk.flags.includes('HIGH_RISK_DOMAIN'));
  });

  it('no-signal no-support case returns bilinmiyor', () => {
    const result = classifySemanticTrust({
      supportScore: 0,
      contradictionScore: 0,
      riskScore: 0,
      signals: [],
    });

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.strictEqual(result.classification, 'unsupported');
  });

  it('unrelated claim does not become celiski', () => {
    const signals = runContradictionRules(
      { text: 'aspirin kan inceltici olarak etki eder', subject: 'aspirin' },
      { text: 'aspirin beyaz tablettir', subject: 'aspirin' },
    );
    const result = classifySemanticTrust({
      supportScore: 0.1,
      contradictionScore: buildContradictionScore(signals),
      riskScore: 0.1,
      signals,
    });

    assert.notStrictEqual(result.status, 'celiski');
    assert.strictEqual(result.status, 'bilinmiyor');
  });

  it('risk flags remain secondary metadata and status contract stays stable', () => {
    const signals = runRiskRules(
      { text: 'B737 has 2 engines', subject: 'B737' },
      { match: { confidence: 0.2, evidence: [] } },
    );
    const result = classifySemanticTrust({
      supportScore: 0.2,
      contradictionScore: 0,
      riskScore: buildRiskScore(signals),
      signals,
      risk: { flags: ['HIGH_RISK_DOMAIN'] },
    });

    assert.ok(Array.isArray(result.warnings));
    assert.ok(Array.isArray(result.risk.flags));
    assert.ok(['dogrulandi', 'celiski', 'bilinmiyor'].includes(result.status));
    assert.ok(!['needs_review', 'weak_match', 'unsupported', 'llm-assisted', 'high_risk'].includes(result.status));
  });

  it('output shape is stable and deterministic', () => {
    const first = classifySemanticTrust({
      supportScore: 0.9,
      contradictionScore: 0,
      riskScore: 0.1,
      signals: [],
      meta: { source: 'test' },
    });
    const second = classifySemanticTrust({
      supportScore: 0.9,
      contradictionScore: 0,
      riskScore: 0.1,
      signals: [],
      meta: { source: 'test' },
    });

    assert.deepStrictEqual(first, second);
  });

  it('normalizes classification envelopes without changing status contract', () => {
    const normalized = normalizeSemanticClassification({
      status: 'dogrulandi',
      supportScore: 0.9,
      contradictionScore: 0,
      riskScore: 0.1,
      signals: [],
      warnings: ['X'],
      risk: { flags: ['Y'] },
      meta: { z: 1 },
    });

    assert.strictEqual(normalized.status, 'dogrulandi');
    assert.ok(Array.isArray(normalized.warnings));
    assert.ok(Array.isArray(normalized.risk.flags));
    assert.ok(normalized.meta && typeof normalized.meta === 'object');
  });

  it('can attach semantic meta to an envelope without mutating status', () => {
    const envelope = attachSemanticMeta(
      { status: 'bilinmiyor', meta: { existing: true } },
      {
        supportScore: 0.35,
        contradictionScore: 0,
        riskScore: 0.2,
        signals: [],
      },
    );

    assert.strictEqual(envelope.status, 'bilinmiyor');
    assert.ok(envelope.meta.semantic);
    assert.ok(envelope.meta.existing);
  });

  it('exposes configurable thresholds', () => {
    assert.strictEqual(DEFAULT_SEMANTIC_THRESHOLDS.supportVerified, 0.75);
    assert.strictEqual(DEFAULT_SEMANTIC_THRESHOLDS.contradictionConflict, 0.5);
    assert.strictEqual(DEFAULT_SEMANTIC_THRESHOLDS.riskHigh, 0.4);
  });
});
