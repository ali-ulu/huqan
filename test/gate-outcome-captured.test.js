'use strict';

/**
 * #3500 (R45): a fail-closed gate fault is recorded as `captured`, not as a
 * refusal, and is never learned from.
 *
 * A `blocked` outcome is a person or a rule refusing the action. A gate that
 * throws is the guard failing to decide. Before this they were one value, so
 * the guard's own noise could teach the outcome miners that a command or a
 * destination had been refused -- a rule no person ever agreed to.
 *
 * Built through the real receipt builders and the real miners, so the trail
 * under test is the trail production writes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
  EFFECT_VERIFICATION,
} = require('../lib/external-action-receipt');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');
const { projectGateOutcomeTrail } = require('../lib/gate-outcome-projection');
const { mineResidencyRule } = require('../lib/residency-rule-miner');
const { mineCommandAllowlist } = require('../lib/command-allowlist-miner');
const { CAPTURED_OUTCOME_STATUS } = require('../lib/gate-outcome-history');

const NOW = () => '2026-10-07T00:00:00.000Z';

function envelope(overrides = {}) {
  return normalizeExternalActionEnvelope({
    invocationId: 'inv-captured-1',
    workspaceId: 'default',
    agent: { name: 'codex', version: '1' },
    action: { kind: 'shell', command: 'rm -rf /tmp/x' },
    ...overrides,
  });
}

function admission(env, findings, decision = 'block') {
  return buildExternalActionAdmissionReceipt(env, {
    decision,
    reason: decision === 'block' ? 'external_action_gate_error' : 'review_required',
    risk: { level: 'critical', score: 100 },
    findings,
  }, { now: NOW });
}

const GATE_FAULT_FINDING = Object.freeze({
  gate: 'AB5', decision: 'block', reason: 'external_action_gate_error', error: 'gate exploded on purpose',
});

const EGRESS_FINDING = Object.freeze({
  gate: 'AB9', decision: 'review', reason: 'data_residency_review',
  destinations: ['exfil.example.com'], piiTypes: ['email'],
});

test('a blocked admission whose gate faulted is captured, not blocked', () => {
  const env = envelope();
  const faulted = buildExternalActionOutcomeReceipt(env, admission(env, [GATE_FAULT_FINDING]),
    { status: 'blocked', reason: 'gate fault' }, { now: NOW });
  assert.equal(faulted.status, CAPTURED_OUTCOME_STATUS);
  // A gate fault ran nothing, so no effect verification can be claimed.
  assert.equal(faulted.metadata.effectVerification, EFFECT_VERIFICATION.NONE);
});

test('a blocked admission with a real rule refusal stays blocked', () => {
  const env = envelope();
  const refused = buildExternalActionOutcomeReceipt(env, admission(env, [
    { gate: 'denylist', decision: 'block', reason: 'denylisted_command_blocked' },
  ]), { status: 'blocked', reason: 'denylisted' }, { now: NOW });
  assert.equal(refused.status, 'blocked');
});

test('the projection shows a captured outcome and never promotes it', () => {
  const env = envelope();
  const admissionReceipt = admission(env, [GATE_FAULT_FINDING]);
  const outcomeReceipt = buildExternalActionOutcomeReceipt(env, admissionReceipt,
    { status: 'blocked', reason: 'gate fault' }, { now: NOW });

  const projection = projectGateOutcomeTrail([admissionReceipt, outcomeReceipt]);
  assert.equal(projection.claims.length, 0, 'a gate fault is never a claim');
  const captured = projection.pending.find((entry) => entry.receiptId === outcomeReceipt.receiptId);
  assert.ok(captured, 'the captured outcome is visible, not silent');
  assert.equal(captured.captured, true);
  assert.match(captured.why, /fail-closed gate fault/);
});

test('a captured outcome is not learned as a refusal by the residency miner', () => {
  const env = envelope();
  // AB9 observed a destination and a later gate faulted, so the action was
  // never judged. The destination must not be recorded as refused.
  const admissionReceipt = admission(env, [EGRESS_FINDING, GATE_FAULT_FINDING]);
  const outcomeReceipt = buildExternalActionOutcomeReceipt(env, admissionReceipt,
    { status: 'blocked', reason: 'gate fault' }, { now: NOW });

  const mined = mineResidencyRule([admissionReceipt, outcomeReceipt], { minObservations: 1 });
  assert.equal(mined.proposal, null, 'a gate fault proposes no residency rule');
  const entry = mined.evidence.find((row) => row.destination === 'exfil.example.com');
  assert.ok(entry);
  assert.equal(entry.refused, 0, 'a gate fault is not a refusal');
  assert.equal(entry.unresolved, 1);
  const why = mined.unresolved.find((row) => row.destination === 'exfil.example.com');
  assert.match(why.why, /only 0 approval/);
  assert.doesNotMatch(why.why, /refused/);
});

test('a captured outcome never produces a command allowlist proposal', () => {
  const env = envelope();
  const admissionReceipt = admission(env, [GATE_FAULT_FINDING], 'review');
  const outcomeReceipt = buildExternalActionOutcomeReceipt(env, admissionReceipt,
    { status: 'blocked', reason: 'gate fault' }, { now: NOW });
  const shapes = [{
    admissionId: admissionReceipt.admissionId,
    workspaceId: 'default',
    shape: 'rm -rf /tmp/x',
    riskCategory: 'tool_chain_execution',
  }];

  const mined = mineCommandAllowlist([admissionReceipt, outcomeReceipt], { shapes, minObservations: 1 });
  assert.deepEqual(mined.proposals, []);
});
