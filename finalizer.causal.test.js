const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildCausalSummary, deriveCausalRecommendation } = require('./finalizer');

describe('Causal Finalizer - v0.7', () => {
  it('buildCausalSummary başarısız simülasyon için hata döndürür', () => {
    const result = buildCausalSummary({ ok: false, error: 'Test error' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'Test error');
    assert.strictEqual(result.outcomes.length, 0);
    assert.strictEqual(result.risks.length, 0);
  });

  it('buildCausalSummary boş simülasyon için varsayılan değerler döndürür', () => {
    const result = buildCausalSummary({ ok: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outcomes.length, 0);
    assert.strictEqual(result.risks.length, 0);
    assert.strictEqual(result.confidence, 0);
    assert.strictEqual(result.causalChains, 0);
    assert.ok(result.summary);
    assert.ok(result.recommendation);
  });

  it('buildCausalSummary outcomes normalleştirir', () => {
    const simulation = {
      ok: true,
      action: 'Test action',
      nodeId: 'A',
      changeType: 'modify',
      outcomes: [
        {
          chain: [{ from: 'A', to: 'B', relation: 'CAUSES', strength: 0.8, confidence: 0.75 }],
          impact: 0.8,
          confidence: 0.75,
          description: 'A causes B'
        }
      ],
      risks: [],
      confidence: 0.75,
      causalChains: 1,
      summary: 'Test summary'
    };

    const result = buildCausalSummary(simulation);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'Test action');
    assert.strictEqual(result.nodeId, 'A');
    assert.strictEqual(result.changeType, 'modify');
    assert.strictEqual(result.outcomes.length, 1);
    assert.strictEqual(result.outcomes[0].chain.length, 1);
    assert.strictEqual(result.outcomes[0].chain[0].from, 'A');
    assert.strictEqual(result.outcomes[0].chain[0].to, 'B');
    assert.strictEqual(result.outcomes[0].impact, 0.8);
    assert.strictEqual(result.outcomes[0].confidence, 0.75);
  });

  it('buildCausalSummary risks normalleştirir', () => {
    const simulation = {
      ok: true,
      outcomes: [],
      risks: [
        {
          chain: ['B', 'C'],
          severity: 'critical',
          description: 'Critical risk'
        }
      ],
      confidence: 0.8,
      causalChains: 1
    };

    const result = buildCausalSummary(simulation);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.risks.length, 1);
    assert.strictEqual(result.risks[0].severity, 'critical');
    assert.strictEqual(result.risks[0].description, 'Critical risk');
  });

  it('buildCausalSummary severity validation yapar', () => {
    const simulation = {
      ok: true,
      outcomes: [],
      risks: [
        { chain: [], severity: 'invalid', description: 'Test' },
        { chain: [], severity: 'high', description: 'Test' },
        { chain: [], severity: 'critical', description: 'Test' }
      ],
      confidence: 0.5,
      causalChains: 0
    };

    const result = buildCausalSummary(simulation);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.risks.length, 3);
    assert.strictEqual(result.risks[0].severity, 'medium'); // invalid -> medium
    assert.strictEqual(result.risks[1].severity, 'high');
    assert.strictEqual(result.risks[2].severity, 'critical');
  });

  it('buildCausalSummary recommendation türetir', () => {
    const simulation = {
      ok: true,
      outcomes: [],
      risks: [],
      confidence: 0.8,
      causalChains: 0
    };

    const result = buildCausalSummary(simulation);
    assert.strictEqual(result.ok, true);
    assert.ok(result.recommendation);
    assert.ok(result.recommendation.includes('güvenli'));
  });

  it('deriveCausalRecommendation risk yoksa güvenli önerir', () => {
    const rec = deriveCausalRecommendation([], 0.8);
    assert.ok(rec.includes('güvenli'));
  });

  it('deriveCausalRecommendation düşük confidence ile uyarır', () => {
    const rec = deriveCausalRecommendation([], 0.5);
    assert.ok(rec.includes('confidence düşük'));
  });

  it('deriveCausalRecommendation kritik risk için reddeder', () => {
    const risks = [{ severity: 'critical', description: 'Test' }];
    const rec = deriveCausalRecommendation(risks, 0.8);
    assert.ok(rec.includes('KRİTİK'));
    assert.ok(rec.includes('önerilmiyor'));
  });

  it('deriveCausalRecommendation yüksek risk için uyarır', () => {
    const risks = [{ severity: 'high', description: 'Test' }];
    const rec = deriveCausalRecommendation(risks, 0.8);
    assert.ok(rec.includes('YÜKSEK RİSK'));
    assert.ok(rec.includes('Dikkatli'));
  });

  it('deriveCausalRecommendation medium risk için değerlendirme önerir', () => {
    const risks = [{ severity: 'medium', description: 'Test' }];
    const rec = deriveCausalRecommendation(risks, 0.8);
    assert.ok(rec.includes('risk tespit edildi'));
    assert.ok(rec.includes('değerlendirip'));
  });

  it('buildCausalSummary null/undefined değerleri handle eder', () => {
    const simulation = {
      ok: true,
      action: null,
      nodeId: undefined,
      changeType: null,
      outcomes: null,
      risks: undefined,
      confidence: null,
      causalChains: null
    };

    const result = buildCausalSummary(simulation);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, '');
    assert.strictEqual(result.nodeId, '');
    assert.strictEqual(result.changeType, 'unknown');
    assert.strictEqual(result.outcomes.length, 0);
    assert.strictEqual(result.risks.length, 0);
    assert.strictEqual(result.confidence, 0);
    assert.strictEqual(result.causalChains, 0);
  });

  it('buildCausalSummary causal mode için deterministic yargı özeti üretir', () => {
    const simulation = {
      ok: true,
      mode: 'causal',
      action: 'autoLearn default true yap',
      nodeId: 'autoLearn_default_true',
      changeType: 'modify',
      input: {
        action: 'autoLearn default true yap',
        nodeId: 'autoLearn_default_true',
        changeType: 'modify',
        maxDepth: 10,
      },
      outcomes: [
        {
          chain: [{ from: 'autoLearn_default_true', to: 'unsupported_llm_output', relation: 'CAUSES', strength: 0.9, confidence: 0.85 }],
          relation: 'CAUSES',
          effect: 'direct',
          impact: 0.9,
          confidence: 0.85,
          severity: 'critical',
          evidence: ['shield-policy'],
          description: 'autoLearn default true causes unsupported LLM output',
        },
      ],
      risks: [
        {
          chain: ['unsupported_llm_output'],
          relation: 'CAUSES',
          severity: 'critical',
          impact: 0.9,
          confidence: 0.85,
          description: 'CAUSES: autoLearn_default_true → unsupported_llm_output',
        },
      ],
      confidence: 0.85,
      causalChains: 1,
      affectedNodes: [
        {
          nodeId: 'unsupported_llm_output',
          label: 'unsupported LLM output',
          relation: 'CAUSES',
          effect: 'direct',
          impact: 0.9,
          confidence: 0.85,
          severity: 'critical',
          path: ['unsupported_llm_output'],
        },
      ],
      evidence: ['shield-policy'],
      unknowns: ['Unsupported output details are missing'],
      recommendation: 'Change is not recommended.',
      traversal: { loops: [], stoppedReason: 'exhausted', maxDepth: 10, confidence: 0.85 },
      summary: 'Simulation found 1 outcome(s) with 1 risk(s). Confidence: 85.0%',
    };

    const result = buildCausalSummary(simulation);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'causal');
    assert.strictEqual(result.riskLevel, 'critical');
    assert.ok(result.conclusion.includes('Değişiklik önerilmiyor'));
    assert.ok(result.conclusion.includes('Confidence'));
    assert.ok(result.recommendation.includes('Change is not recommended'));
    assert.strictEqual(result.affectedNodes.length, 1);
    assert.strictEqual(result.evidence.length, 1);
    assert.strictEqual(result.nextQuestions.length >= 2, true);
        assert.ok(result.nextQuestions.some(q => q.toLowerCase().includes('onay')));
        assert.ok(result.nextQuestions.some(q => q.toLowerCase().includes('onay')));
    assert.strictEqual(result.unknowns.length, 1);
  });

  it('buildCausalSummary risk seviyelerini insan okunur hükme çevirir', () => {
    const cases = [
      { severity: 'critical', expected: 'Değişiklik önerilmiyor.' },
      { severity: 'high', expected: 'Yüksek risk; insan onayı gerekir.' },
      { severity: 'medium', expected: 'Dikkatli uygulanmalı.' },
      { severity: 'low', expected: 'Düşük risk.' },
      { severity: 'unknown', expected: 'Yetersiz causal veri.' },
    ];

    for (const testCase of cases) {
      const result = buildCausalSummary({
        ok: true,
        mode: 'causal',
        outcomes: [],
        risks: [{ chain: [], severity: testCase.severity, description: 'risk' }],
        confidence: 0.6,
        causalChains: 1,
        evidence: ['evidence'],
        unknowns: [],
      });

      assert.strictEqual(result.riskLevel, testCase.severity);
      assert.ok(result.conclusion.includes(testCase.expected));
    }
  });

  it('buildCausalSummary causal chain yoksa yetersiz veri döner', () => {
    const result = buildCausalSummary({
      ok: true,
      mode: 'causal',
      outcomes: [],
      risks: [],
      confidence: 0,
      causalChains: 0,
      evidence: [],
      unknowns: [],
      summary: '',
    });

    assert.strictEqual(result.riskLevel, 'unknown');
    assert.ok(result.conclusion.includes('Yetersiz causal veri'));
    assert.ok(result.nextQuestions.length > 0);
    assert.ok(result.nextQuestions[0].includes('causal zincir'));
  });
});

