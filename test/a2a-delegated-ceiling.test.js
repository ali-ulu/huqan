'use strict';

// The A2A cross-agent aggregation records the receiver's own risk score and
// the delegated risk tier as a ceiling on the 0-100 scale (#2505). Recorded
// only: no admission decision changes.

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run');
const {
  aggregateInterAgentReceiptDecision,
  evaluateInterAgentReceiptAdmission,
} = require('../lib/a2a/inter-agent-receipt-chain');

const CEILINGS = Object.freeze({ low: 24, medium: 49, high: 74, critical: 100 });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('the receiver side uses its firewall risk score on the 0-100 scale, not a table keyed on its decision', () => {
  const fixture = buildFixture();
  const aggregation = aggregateInterAgentReceiptDecision(fixture.request, {
    decision: 'review', reason: 'receiver_review', risk: { score: 0.62 },
  });
  assert.equal(aggregation.receiver.risk_score, 62);
  assert.equal(aggregation.receiver.risk_source, 'receiver_firewall_score');
  assert.equal(aggregation.aggregate_risk_score, Math.max(aggregation.parent.risk_score, 62));
});

test('a receiver decision without a score falls back to the decision table, and says so', () => {
  const fixture = buildFixture();
  const aggregation = aggregateInterAgentReceiptDecision(fixture.request, { decision: 'block', reason: 'receiver_block' });
  assert.equal(aggregation.receiver.risk_score, 100);
  assert.equal(aggregation.receiver.risk_source, 'receiver_decision_fallback');
  assert.equal(aggregation.aggregate_risk_score, 100);
});

test('the delegated tier ceiling is recorded with whether the receiver stayed within it, and is not enforced', () => {
  const fixture = buildFixture();
  const tier = fixture.request.constraints.maxRiskTier;
  assert.ok(Object.hasOwn(CEILINGS, tier), `the fixture carries a known tier, got ${tier}`);

  const low = aggregateInterAgentReceiptDecision(fixture.request, {
    decision: 'allow', reason: 'receiver_allow', risk: { score: 0.05 },
  });
  assert.deepEqual(low.delegated_ceiling, {
    max_risk_tier: tier,
    ceiling_score: CEILINGS[tier],
    within_ceiling: 5 <= CEILINGS[tier],
    status: 'computed',
    enforced: false,
  });

  const high = aggregateInterAgentReceiptDecision(fixture.request, {
    decision: 'allow', reason: 'receiver_allow', risk: { score: 1 },
  });
  assert.equal(high.delegated_ceiling.within_ceiling, CEILINGS[tier] >= 100);
  assert.equal(high.delegated_ceiling.enforced, false);
});

test('each tier maps to the top of its taxonomy band', () => {
  const fixture = buildFixture();
  for (const [tier, ceiling] of Object.entries(CEILINGS)) {
    const request = clone(fixture.request);
    request.constraints.maxRiskTier = tier;
    const atCeiling = aggregateInterAgentReceiptDecision(request, {
      decision: 'allow', reason: 'receiver_allow', risk: { score: ceiling / 100 },
    });
    assert.equal(atCeiling.delegated_ceiling.ceiling_score, ceiling);
    assert.equal(atCeiling.delegated_ceiling.within_ceiling, true);
    if (ceiling < 100) {
      const above = aggregateInterAgentReceiptDecision(request, {
        decision: 'allow', reason: 'receiver_allow', risk: { score: (ceiling + 1) / 100 },
      });
      assert.equal(above.delegated_ceiling.within_ceiling, false, `${tier} is exceeded at ${ceiling + 1}`);
    }
  }
});

test('an unrecognised or missing tier ceiling is unknown, not assumed', () => {
  const fixture = buildFixture();
  for (const maxRiskTier of ['extreme', undefined]) {
    const request = clone(fixture.request);
    if (maxRiskTier === undefined) delete request.constraints.maxRiskTier;
    else request.constraints.maxRiskTier = maxRiskTier;
    const aggregation = aggregateInterAgentReceiptDecision(request, {
      decision: 'allow', reason: 'receiver_allow', risk: { score: 0.05 },
    });
    assert.deepEqual(aggregation.delegated_ceiling, {
      max_risk_tier: maxRiskTier ?? null,
      ceiling_score: null,
      within_ceiling: null,
      status: 'unknown',
      enforced: false,
    });
  }
});

test('recording the receiver score and the ceiling moves no admission decision', () => {
  const fixture = buildFixture();
  for (const receiver of [
    { decision: 'allow', reason: 'receiver_allow', risk: { score: 1 } },
    { decision: 'block', reason: 'receiver_block', risk: { score: 0 } },
  ]) {
    const admission = evaluateInterAgentReceiptAdmission(fixture.request, receiver);
    assert.equal(admission.decision, receiver, 'a parent that allows passes the receiver decision through unchanged');
  }
});
