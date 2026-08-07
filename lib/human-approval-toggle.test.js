const test = require('node:test');
const assert = require('node:assert/strict');

const { isHumanApprovalDisabled, applyHumanApprovalToggle } = require('./human-approval-toggle');

test('human-approval-toggle: isHumanApprovalDisabled requires the exact string "true"', () => {
  assert.equal(isHumanApprovalDisabled({}), false);
  assert.equal(isHumanApprovalDisabled({ AXIOM_HUMAN_APPROVAL_DISABLED: 'false' }), false);
  assert.equal(isHumanApprovalDisabled({ AXIOM_HUMAN_APPROVAL_DISABLED: '1' }), false);
  assert.equal(isHumanApprovalDisabled({ AXIOM_HUMAN_APPROVAL_DISABLED: 'TRUE' }), false);
  assert.equal(isHumanApprovalDisabled({ AXIOM_HUMAN_APPROVAL_DISABLED: 'true' }), true);
});

test('human-approval-toggle: applyHumanApprovalToggle is a no-op when the env flag is unset (default fail-closed)', () => {
  const gate = { decision: 'review', reason: 'AB2_BLOCKED', canExecute: false, allowed: false };
  const result = applyHumanApprovalToggle(gate, {});
  assert.deepEqual(result, gate);
});

test('human-approval-toggle: applyHumanApprovalToggle auto-approves a review decision when enabled', () => {
  const gate = {
    decision: 'review',
    reason: 'AB2_BLOCKED',
    canExecute: false,
    allowed: false,
    requiredReview: true,
    metadata: { adapterVersion: 'v1', tool: 'axiom.learn' },
  };
  const result = applyHumanApprovalToggle(gate, { AXIOM_HUMAN_APPROVAL_DISABLED: 'true' });

  assert.equal(result.decision, 'allow');
  assert.equal(result.allowed, true);
  assert.equal(result.canExecute, true);
  assert.equal(result.requiredReview, false);
  assert.equal(result.metadata.autoApproved, true);
  assert.equal(result.metadata.autoApprovedReason, 'human_approval_disabled');
  assert.equal(result.metadata.originalDecision, 'review');
  assert.equal(result.metadata.originalReason, 'AB2_BLOCKED');
  assert.equal(result.metadata.adapterVersion, 'v1', 'existing metadata fields must survive');
});

test('human-approval-toggle: applyHumanApprovalToggle never touches a block decision, even when enabled', () => {
  const gate = { decision: 'block', reason: 'AB1_BLOCKED', canExecute: false, allowed: false };
  const result = applyHumanApprovalToggle(gate, { AXIOM_HUMAN_APPROVAL_DISABLED: 'true' });
  assert.deepEqual(result, gate);
});

test('human-approval-toggle: applyHumanApprovalToggle never touches an allow or dry_run_only decision', () => {
  const allowGate = { decision: 'allow', reason: 'READ_ONLY_ALLOW', canExecute: true, allowed: true };
  const dryRunGate = { decision: 'dry_run_only', reason: 'AGENT_DRY_RUN', canExecute: false, canDryRun: true };
  const env = { AXIOM_HUMAN_APPROVAL_DISABLED: 'true' };
  assert.deepEqual(applyHumanApprovalToggle(allowGate, env), allowGate);
  assert.deepEqual(applyHumanApprovalToggle(dryRunGate, env), dryRunGate);
});

test('human-approval-toggle: applyHumanApprovalToggle handles a missing/null gate gracefully', () => {
  assert.equal(applyHumanApprovalToggle(null, { AXIOM_HUMAN_APPROVAL_DISABLED: 'true' }), null);
  assert.equal(applyHumanApprovalToggle(undefined, { AXIOM_HUMAN_APPROVAL_DISABLED: 'true' }), undefined);
});
