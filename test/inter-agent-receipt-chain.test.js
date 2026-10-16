'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run');
const {
  aggregateInterAgentReceiptDecision,
  evaluateInterAgentReceiptAdmission,
  validateInterAgentRouteReceipt,
} = require('../lib/a2a/inter-agent-receipt-chain');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('inter-agent receipt: delegated task is bound to its verified parent receipt', () => {
  const fixture = buildFixture();
  const sourceIdentity = fixture.authority.identities.find(
    (entry) => entry.ref === fixture.request.source.identityRef,
  );

  assert.equal(
    fixture.request.routeReceipt.parent_receipt_id,
    fixture.request.evidence.receipt.publicReceiptId,
  );
  assert.equal(validateInterAgentRouteReceipt(fixture.request, sourceIdentity.record), null);

  const mismatched = clone(fixture.request);
  mismatched.routeReceipt.parent_receipt_id = '0'.repeat(64);
  assert.equal(
    validateInterAgentRouteReceipt(mismatched, sourceIdentity.record),
    'route_receipt_invalid',
  );
});

test('inter-agent receipt: parent allow and receiver block emit a risk signal', () => {
  const fixture = buildFixture();
  const aggregation = aggregateInterAgentReceiptDecision(fixture.request, {
    decision: 'block',
    reason: 'receiver_disagrees',
  });

  assert.equal(aggregation.status, 'contradiction');
  assert.equal(aggregation.signal, 'cross_agent_decision_contradiction');
  assert.equal(aggregation.parent.decision, 'allow');
  assert.equal(aggregation.receiver.decision, 'block');
  assert.equal(aggregation.aggregate_risk_score, 100);
});

test('inter-agent receipt: parent block and receiver allow preserve the disagreement', () => {
  const fixture = buildFixture();
  const request = clone(fixture.request);
  request.evidence.receipt.disclosure.decision = 'block';
  request.evidence.receipt.disclosure.verdict = 'block';

  const admission = evaluateInterAgentReceiptAdmission(request, {
    decision: 'allow',
    reason: 'receiver_would_allow',
    metadata: { firewallVersion: 'test' },
  });

  assert.equal(admission.decision.decision, 'block');
  assert.equal(admission.decision.reason, 'PARENT_RECEIPT_NOT_AUTHORIZING');
  assert.equal(admission.aggregation.status, 'contradiction');
  assert.equal(admission.aggregation.signal, 'cross_agent_decision_contradiction');
  assert.equal(admission.aggregation.parent.decision, 'block');
  assert.equal(admission.aggregation.receiver.decision, 'allow');
});
