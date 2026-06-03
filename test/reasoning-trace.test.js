const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateSubclaimVerdicts,
  attachReasoningTrace,
  buildReasoningTrace,
  normalizeTraceStep,
} = require('../lib/reasoning-trace');

describe('reasoning-trace', () => {
  it('aggregates supported and contradicted subclaims conservatively', () => {
    const aggregate = aggregateSubclaimVerdicts([
      { id: 'claim_1', claim: 'A', required: true, status: 'dogrulandi', confidence: 0.9, evidence: [{ text: 'A' }], downgradeReasons: [] },
      { id: 'claim_2', claim: 'B', required: true, status: 'celiski', confidence: 0.8, evidence: [{ text: 'B' }], downgradeReasons: ['CONTRADICTION_SUBCLAIM'] },
    ], { confidenceFloor: 0.65 });

    assert.strictEqual(aggregate.status, 'celiski');
    assert.strictEqual(aggregate.finalRule, 'ANY_REQUIRED_CONTRADICTED');
    assert.ok(aggregate.reasons.includes('CONTRADICTION_SUBCLAIM'));
  });

  it('downgrades below confidence floor even when all subclaims support', () => {
    const aggregate = aggregateSubclaimVerdicts([
      { id: 'claim_1', claim: 'A', required: true, status: 'dogrulandi', confidence: 0.8, evidence: [{ text: 'A' }], downgradeReasons: [] },
      { id: 'claim_2', claim: 'B', required: true, status: 'dogrulandi', confidence: 0.6, evidence: [{ text: 'B' }], downgradeReasons: [] },
    ], { confidenceFloor: 0.65 });

    assert.strictEqual(aggregate.status, 'bilinmiyor');
    assert.strictEqual(aggregate.finalRule, 'CONFIDENCE_FLOOR');
    assert.ok(aggregate.reasons.includes('CONFIDENCE_FLOOR'));
  });

  it('builds a deterministic reasoning trace with preview metadata', () => {
    const decomposition = {
      originalClaim: 'React Native is used in production and React Native is performant',
      compound: true,
      subclaims: [
        { id: 'claim_1', claim: 'React Native is used in production', required: true, source: 'deterministic' },
        { id: 'claim_2', claim: 'React Native is performant', required: true, source: 'deterministic' },
      ],
      warnings: [],
    };
    const subclaimOutcomes = [
      { id: 'claim_1', claim: 'React Native is used in production', required: true, status: 'dogrulandi', confidence: 0.9, evidence: [{ text: 'React Native is used in production' }], rejectedEvidence: [], downgradeReasons: [], semanticTrust: { warnings: [] }, risk: { flags: [] } },
      { id: 'claim_2', claim: 'React Native is performant', required: true, status: 'bilinmiyor', confidence: 0.35, evidence: [], rejectedEvidence: [{ text: 'React Native has performance issues' }], downgradeReasons: ['WEAK_SUPPORT'], semanticTrust: { warnings: ['WEAK_SUPPORT'] }, risk: { flags: ['WEAK_SUPPORT'] } },
    ];
    const aggregate = aggregateSubclaimVerdicts(subclaimOutcomes, { confidenceFloor: 0.65 });
    const first = buildReasoningTrace({
      claim: decomposition.originalClaim,
      decomposition,
      subclaimOutcomes,
      aggregate,
      semanticFlags: ['WEAK_SUPPORT'],
    });
    const second = buildReasoningTrace({
      claim: decomposition.originalClaim,
      decomposition,
      subclaimOutcomes,
      aggregate,
      semanticFlags: ['WEAK_SUPPORT'],
    });

    assert.deepStrictEqual(first, second);
    assert.strictEqual(first.mode, 'semantic-trace');
    assert.strictEqual(first.steps[0].type, 'decomposition');
    assert.strictEqual(first.steps[1].type, 'subclaim_verification');
    assert.strictEqual(first.steps[2].type, 'subclaim_verification');
    assert.strictEqual(first.steps[3].type, 'aggregation');
    assert.strictEqual(first.summary.total, 2);
    assert.strictEqual(first.trustReceiptPreview.subclaimCount, 2);
    assert.strictEqual(first.trustReceiptPreview.contradictionCount, 0);
    assert.ok(Array.isArray(first.trustReceiptPreview.downgradeReasons));
  });

  it('normalizes trace steps', () => {
    const step = normalizeTraceStep({
      type: 'subclaim_verification',
      claim: 'A',
      status: 'dogrulandi',
      confidence: 0.7,
      warnings: ['X'],
      evidence: [{ text: 'A' }],
    });

    assert.strictEqual(step.type, 'subclaim_verification');
    assert.strictEqual(step.status, 'dogrulandi');
    assert.deepStrictEqual(step.warnings, ['X']);
    assert.ok(Array.isArray(step.evidence));
  });

  it('attaches trace metadata without mutating the verify envelope status', () => {
    const result = attachReasoningTrace({ status: 'bilinmiyor', meta: { existing: true } }, {
      claim: 'A',
      mode: 'semantic-trace',
      steps: [],
      summary: { supported: 0, contradicted: 0, unknown: 1, finalRule: 'PARTIAL_OR_UNKNOWN' },
      trustReceiptPreview: { originalClaim: 'A' },
    });

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.ok(result.meta.reasoningTrace);
    assert.ok(result.meta.trustReceiptPreview);
    assert.ok(result.meta.existing);
  });
});
