'use strict';

/**
 * #3617 (R52): an execution the guard allowed while a gate was holding a
 * degraded input is filed as `executed_but_degraded`, not as a clean
 * `executed`.
 *
 * A gate that cannot measure its input holds the action for review instead of
 * guessing (see lib/impact-budget-gate.js). A human can approve that hold and
 * the action then runs -- but the admission receipt still carries the degraded
 * finding, so the guard was not whole when it allowed the action. Filing that
 * as a plain `executed` would hand the outcome miners a full approval learned
 * from a half-made decision.
 *
 * Built through the real receipt builders and the real miners, so the trail
 * under test is the trail production writes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
} = require('../lib/external-action-receipt');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');
const { projectGateOutcomeTrail } = require('../lib/gate-outcome-projection');
const { mineCommandAllowlist } = require('../lib/command-allowlist-miner');
const {
  DEGRADED_OUTCOME_STATUS,
  isDegradedOutcomeStatus,
  verdictForOutcomeStatus,
} = require('../lib/gate-outcome-history');

const NOW = () => '2026-10-07T00:00:00.000Z';

function envelope(overrides = {}) {
  return normalizeExternalActionEnvelope({
    invocationId: 'inv-degraded-1',
    workspaceId: 'default',
    agent: { name: 'codex', version: '1' },
    action: { kind: 'shell', command: 'git push origin main' },
    ...overrides,
  });
}

// The exact shape lib/impact-budget-gate.js#degradedFinding writes: a review
// hold, enforced, with a human-readable reason it could not measure.
const DEGRADED_HOLD_FINDING = Object.freeze({
  gate: 'impact-budget',
  decision: 'review',
  reason: 'external_action_impact_budget_degraded_review',
  enforced: true,
  detail: 'missing score or scope',
});

// An ordinary budget review: the guard measured the action and the projection
// crossed a threshold. Enforced, but with no `detail` -- it is a decision, not
// a failure to decide.
const MEASURED_REVIEW_FINDING = Object.freeze({
  gate: 'impact-budget',
  decision: 'review',
  reason: 'external_action_impact_budget_review_required',
  enforced: true,
  projected: 120,
  bands: { reviewAt: 100, quorumAt: 150, blockAt: 200 },
});

function admission(env, findings, decision = 'review') {
  return buildExternalActionAdmissionReceipt(env, {
    decision,
    reason: decision === 'allow' ? 'external_action_allowed' : 'external_action_review_required',
    risk: { level: 'medium', score: 50 },
    findings,
  }, { now: NOW });
}

test('a success behind a degraded hold is executed_but_degraded, not executed', () => {
  const env = envelope();
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env, [DEGRADED_HOLD_FINDING]),
    { status: 'success', reason: 'ran after approval' }, { now: NOW });
  assert.equal(receipt.status, DEGRADED_OUTCOME_STATUS);
  assert.equal(receipt.metadata.outcomeStatus, DEGRADED_OUTCOME_STATUS);
});

test('a success behind an ordinary (measured) review is a clean executed', () => {
  const env = envelope();
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env, [MEASURED_REVIEW_FINDING]),
    { status: 'success' }, { now: NOW });
  assert.equal(receipt.status, 'executed');
});

test('a success behind a clean allow is a clean executed', () => {
  const env = envelope();
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env, [], 'allow'),
    { status: 'success' }, { now: NOW });
  assert.equal(receipt.status, 'executed');
});

test('a caller cannot re-label a clean allow as degraded by saying so', () => {
  const env = envelope();
  // The outcome claims degradation, but the admission receipt -- the authority
  // -- carries no degraded hold, so the status stays a clean executed.
  const receipt = buildExternalActionOutcomeReceipt(env, admission(env, [], 'allow'),
    { status: 'success', reason: 'degraded, trust me' }, { now: NOW });
  assert.equal(receipt.status, 'executed');
});

test('a degraded execution carries no verdict and is named, never silent', () => {
  assert.equal(DEGRADED_OUTCOME_STATUS, 'executed_but_degraded');
  assert.equal(isDegradedOutcomeStatus('executed_but_degraded'), true);
  for (const status of [undefined, null, '', 'executed', 'blocked', 'captured', 'failed']) {
    assert.equal(isDegradedOutcomeStatus(status), false, String(status));
  }
  assert.equal(verdictForOutcomeStatus(DEGRADED_OUTCOME_STATUS), null);

  const env = envelope();
  const admissionReceipt = admission(env, [DEGRADED_HOLD_FINDING]);
  const outcomeReceipt = buildExternalActionOutcomeReceipt(env, admissionReceipt,
    { status: 'success' }, { now: NOW });

  const projection = projectGateOutcomeTrail([admissionReceipt, outcomeReceipt]);
  assert.equal(projection.claims.length, 0, 'a degraded execution is never a clean claim');
  const entry = projection.pending.find((row) => row.receiptId === outcomeReceipt.receiptId);
  assert.ok(entry, 'the degraded execution is visible, not silent');
  assert.equal(entry.degraded, true);
  assert.equal(entry.captured, false);
  assert.match(entry.why, /degraded execution/);
});

test('a degraded execution never produces a command allowlist proposal', () => {
  const env = envelope();
  const admissionReceipt = admission(env, [DEGRADED_HOLD_FINDING]);
  const outcomeReceipt = buildExternalActionOutcomeReceipt(env, admissionReceipt,
    { status: 'success' }, { now: NOW });
  const shapes = [{
    admissionId: admissionReceipt.admissionId,
    workspaceId: 'default',
    shape: 'git push origin main',
    riskCategory: 'tool_chain_execution',
  }];

  const mined = mineCommandAllowlist([admissionReceipt, outcomeReceipt], { shapes, minObservations: 1 });
  assert.deepEqual(mined.proposals, [], 'a degraded execution is not an approval to learn from');
});

test('the admission receipt carries the degraded hold so the outcome can read it', () => {
  const env = envelope();
  const receipt = admission(env, [DEGRADED_HOLD_FINDING]);
  const finding = receipt.metadata.findings.find((row) => row.gate === 'impact-budget');
  assert.ok(finding);
  assert.equal(finding.enforced, true);
  assert.equal(finding.detail, 'missing score or scope');
});

test('a finding without enforced/detail keeps its exact shape', () => {
  const env = envelope();
  const receipt = admission(env, [{
    gate: 'denylist', decision: 'block', reason: 'denylisted_command_blocked',
  }]);
  const finding = receipt.metadata.findings[0];
  assert.equal(Object.hasOwn(finding, 'enforced'), false);
  assert.equal(Object.hasOwn(finding, 'detail'), false);
});
