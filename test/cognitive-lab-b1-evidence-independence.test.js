'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EFFECT_KIND,
  calibrateRuleBelief,
} = require('../lib/inference-belief-revision');
const { V0_1_CALIBRATION } = require('../lib/cognitive-lab-evaluator');

const RULE_ID = 'rule:b1-source-independence';
const AT = '2026-10-01T00:00:00.000Z';
const MIN_MEANINGFUL_DUPLICATE_REDUCTION = 4;

function pair(decisionId, outcome) {
  return {
    decisionId,
    prediction: {
      score: 50,
      unknown: '',
      actionClass: `inference-rule:${RULE_ID}`,
      at: '2026-09-01T00:00:00.000Z',
    },
    outcome: { state: outcome, at: '2026-09-02T00:00:00.000Z' },
  };
}

function frozenHoldout() {
  const positives = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const adverse = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const pairs = Object.fromEntries([
    ...positives.map((id) => [id, pair(id, 'confirmed')]),
    ...adverse.map((id) => [id, pair(id, 'contradiction')]),
  ]);
  const candidateEvidence = [
    ...positives.map((decisionId) => ({
      decisionId,
      kind: EFFECT_KIND.OBSERVED,
      sourceEventRefs: ['source-event:duplicated-positive'],
    })),
    ...adverse.map((decisionId) => ({
      decisionId,
      kind: EFFECT_KIND.OBSERVED,
      sourceEventRefs: [`source-event:${decisionId}`],
    })),
  ];
  return Object.freeze({ pairs: Object.freeze(pairs), candidateEvidence: Object.freeze(candidateEvidence) });
}

test('B1 holdout baseline/ablation shows meaningful source-independence gain with no trust regression', () => {
  const fixture = frozenHoldout();
  const common = {
    ruleId: RULE_ID,
    declaredConfidence: 0.9,
    at: AT,
    pairs: fixture.pairs,
  };

  // Ablation removes source-event identity. This reproduces the pre-I0 behavior:
  // five correlated reports are treated as five independent positive trials.
  const ablation = calibrateRuleBelief({
    ...common,
    effectEvidence: fixture.candidateEvidence.map(({ decisionId, kind }) => ({ decisionId, kind })),
  });

  const candidate = calibrateRuleBelief({
    ...common,
    effectEvidence: fixture.candidateEvidence,
  });

  const duplicateReduction = ablation.observedSamples - candidate.observedSamples;
  assert.equal(ablation.observedSamples, 10);
  assert.equal(candidate.observedSamples, 6);
  assert.equal(candidate.observedSuccesses, 1);
  assert.equal(candidate.observedFailures, 5);
  assert.deepEqual(candidate.correlatedDecisionIds, ['p2', 'p3', 'p4', 'p5']);
  assert.ok(duplicateReduction >= MIN_MEANINGFUL_DUPLICATE_REDUCTION);
  assert.ok(candidate.systemConfidence <= ablation.systemConfidence, 'source independence must not create trust inflation on the locked holdout');

  // This fixture has no explicit pre-outcome probability p. Rule confidence is
  // not repurposed as an outcome probability, so V0.2-style Brier/ECE remains
  // explicitly unmeasured rather than fabricated.
  assert.equal(V0_1_CALIBRATION.brier, 'NOT_MEASURED');
  assert.equal(V0_1_CALIBRATION.ece, 'NOT_MEASURED');
});
