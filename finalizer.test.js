const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildFinalSummary } = require('./finalizer');

describe('finalizer', () => {
  it('derives a deterministic summary from run data', () => {
    const summary = buildFinalSummary({
      goal: 'kedi hayvandir mi?',
      objective: 'verify',
      status: 'completed',
      finalAnswer: 'verify:kedi hayvandir mi?',
      steps: [
        {
          id: 'ask-1',
          tool: 'ask',
          status: 'done',
          summary: 'Kedi hayvandir',
          result: {
            ok: true,
            data: { answer: 'Kedi hayvandir', source: 'graph' },
            evidence: ['graph-evidence'],
            confidence: 0.7,
          },
        },
        {
          id: 'verify-1',
          tool: 'verify',
          status: 'done',
          summary: 'verify:kedi hayvandir mi?',
          result: {
            ok: true,
            data: { finalAnswer: 'verify:kedi hayvandir mi?', source: 'graph' },
            evidence: [{ type: 'graph', value: 'verify-evidence', confidence: 0.8 }],
            confidence: 0.8,
          },
        },
      ],
      evidence: ['graph-evidence', { type: 'graph', value: 'verify-evidence', confidence: 0.8 }],
    });

    assert.strictEqual(summary.mode, 'graph-backed');
    assert.ok(summary.knownFacts.length >= 2);
    assert.ok(summary.knownFacts.some(item => item.includes('Kedi hayvandir')));
    assert.strictEqual(summary.unknowns.length, 0);
    assert.ok(summary.evidence.length >= 2);
    assert.strictEqual(summary.conclusion, 'The known facts are supported by the graph.');
    assert.ok(Array.isArray(summary.nextQuestions));
  });

  it('marks contradictions as contradicted and surfaces follow-up questions', () => {
    const summary = buildFinalSummary({
      goal: 'kedi hayvandir mi?',
      objective: 'verify',
      status: 'blocked',
      finalAnswer: 'The agent completed the task but could not produce a short summary.',
      steps: [
        {
          id: 'verify-1',
          tool: 'verify',
          status: 'blocked',
          summary: 'celiski: kedi hayvan degildir',
          error: { code: 'CONTRADICTION', message: 'celiski bulundu' },
        },
      ],
      evidence: [],
    });

    assert.strictEqual(summary.mode, 'contradicted');
    assert.ok(summary.unknowns.length >= 1);
    assert.ok(summary.conclusion.includes('contradicts the graph'));
    assert.ok(summary.nextQuestions.length >= 1);
  });

  it('does not infer contradiction or uncertainty from substrings (#1045)', () => {
    const makeRun = (summary) => ({
      goal: 'soru',
      objective: 'investigate',
      status: 'completed',
      steps: [{ tool: 'ask', action: 'ask', status: 'done', summary }],
      evidence: [],
      finalAnswer: summary,
    });

    for (const summary of [
      'Celik bir metaldir.',
      'Bu bir celikhane raporudur.',
      'Sorun unblocked durumda.',
      'There is no database conflict here.',
    ]) {
      const result = buildFinalSummary(makeRun(summary));
      assert.strictEqual(result.mode, 'graph-backed', summary);
      assert.deepStrictEqual(result.unknowns, [], summary);
    }

    assert.strictEqual(buildFinalSummary(makeRun('A direct conflict was found.')).mode, 'contradicted');
    assert.strictEqual(buildFinalSummary(makeRun('There is no data.')).mode, 'insufficient-data');
  });

  it('smoke: summarizes covid19 vs grip analysis with explicit uncertainty', () => {
    const summary = buildFinalSummary({
      goal: "covid19 ve grip arasindaki farklari analiz et ve hasta_ahmet'in durumunu degerlendir",
      objective: 'compare',
      status: 'completed',
      finalAnswer: 'The agent completed the task but could not produce a short summary.',
      steps: [
        {
          id: 'ask-covid',
          tool: 'ask',
          status: 'done',
          summary: 'covid19 yuksek_ates yapar',
          result: {
            ok: true,
            data: { answer: 'covid19 yuksek_ates yapar', source: 'graph' },
            evidence: [{ type: 'graph', value: 'covid19 high fever' }],
            confidence: 0.82,
          },
        },
        {
          id: 'ask-covid-2',
          tool: 'ask',
          status: 'done',
          summary: 'covid19 kuru_oksuruk yapar',
          result: {
            ok: true,
            data: { answer: 'covid19 kuru_oksuruk yapar', source: 'graph' },
            evidence: [{ type: 'graph', value: 'covid19 dry cough' }],
            confidence: 0.81,
          },
        },
        {
          id: 'ask-grip',
          tool: 'ask',
          status: 'done',
          summary: 'grip yuksek_ates yapar',
          result: {
            ok: true,
            data: { answer: 'grip yuksek_ates yapar', source: 'graph' },
            evidence: [{ type: 'graph', value: 'grip high fever' }],
            confidence: 0.79,
          },
        },
        {
          id: 'ask-ahmet',
          tool: 'ask',
          status: 'done',
          summary: "hasta_ahmet yuksek_ates gosteriyor",
          result: {
            ok: true,
            data: { answer: "hasta_ahmet yuksek_ates gosteriyor", source: 'graph' },
            evidence: [{ type: 'graph', value: 'ahmet fever' }],
            confidence: 0.77,
          },
        },
        {
          id: 'ask-symptom',
          tool: 'ask',
          status: 'review',
          summary: 'hasta_ahmet kuru_oksuruk bilinmiyor',
          result: {
            ok: false,
            data: { answer: 'Bilinmiyor', source: 'graph' },
            evidence: [],
            confidence: 0.2,
          },
        },
      ],
      evidence: [
        'covid19 yuksek_ates yapar',
        'covid19 kuru_oksuruk yapar',
        'grip yuksek_ates yapar',
        'hasta_ahmet yuksek_ates gosteriyor',
      ],
    });

    assert.strictEqual(summary.mode, 'insufficient-data');
    assert.ok(summary.knownFacts.some(item => item.includes('covid19 yuksek_ates yapar')));
    assert.ok(summary.knownFacts.some(item => item.includes('grip yuksek_ates yapar')));
    assert.ok(summary.knownFacts.some(item => item.includes('hasta_ahmet yuksek_ates gosteriyor')));
    assert.ok(summary.unknowns.some(item => item.includes('hasta_ahmet kuru_oksuruk bilinmiyor')));
    assert.strictEqual(summary.conclusion, 'The known facts diverged, and some questions remain open.');
    assert.ok(summary.nextQuestions.some(item => item.includes('hasta_ahmet kuru_oksuruk bilinmiyor')));
  });
});
