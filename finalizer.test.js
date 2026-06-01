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
    assert.strictEqual(summary.conclusion, 'Bilinenler graf tarafından destekleniyor.');
    assert.ok(Array.isArray(summary.nextQuestions));
  });

  it('marks contradictions as contradicted and surfaces follow-up questions', () => {
    const summary = buildFinalSummary({
      goal: 'kedi hayvandir mi?',
      objective: 'verify',
      status: 'blocked',
      finalAnswer: 'Ajan gÃ¶revi tamamladÄ± ancak kÄ±sa Ã¶zet Ã¼retilemedi.',
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
    assert.ok(summary.conclusion.includes('çelişiyor'));
    assert.ok(summary.nextQuestions.length >= 1);
  });
});
