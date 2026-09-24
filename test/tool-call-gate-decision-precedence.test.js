'use strict';

/**
 * Decision precedence in evaluateToolCall and the defaults of
 * normalizeGateDecision, pinned with inputs that tell each rule apart.
 *
 * Several rules in lib/tool-call-gate.js back each other up (a missing
 * classifier turns `allow` into `review` both before and after the policy
 * floor, for example), so a test that only reaches the common path cannot
 * notice one of them breaking. Each case below is chosen so that exactly one
 * rule decides the outcome. Written when #2151 moved the decision code into a
 * smaller mutation target and the mutation gate showed these paths untested.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AB2_POLICY_VERSION,
  TOOL_GATE_DECISIONS: D,
  TOOL_GATE_REASONS: R,
  evaluateToolCall,
  normalizeGateDecision,
} = require('../lib/tool-call-gate');

const classifier = Object.freeze({
  classifierVersion: 'AB1-v2.0.0',
  risk: { level: 'low', score: 0.2, category: 'read' },
  valid: true,
});
const read = (extra = {}) => ({ action: 'read', toolName: 'list-files', classifier, ...extra });

test('a missing classifier turns allow into review before the policy floor can lift it', () => {
  // Without the early rule the floor would raise allow to dry_run_only with a
  // policy reason; the classifier rule must win first.
  const result = evaluateToolCall({ action: 'read', toolName: 'list-files' }, { minimumDecision: 'dry_run_only' });
  assert.equal(result.decision, D.REVIEW);
  assert.equal(result.reason, R.REVIEW_REQUIRED);
});

test('the policy floor lifts allow to dry_run_only, keeps allow at allow, and keeps an equal decision\'s reason', () => {
  const lifted = evaluateToolCall(read(), { minimumDecision: 'dry_run_only' });
  assert.equal(lifted.decision, D.DRY_RUN_ONLY);
  assert.equal(lifted.reason, R.POLICY_OVERRIDE_REVIEW);
  assert.equal(lifted.dryRunOnly, true);
  assert.equal(lifted.canExecute, false);

  const unchanged = evaluateToolCall(read(), { minimumDecision: 'allow' });
  assert.equal(unchanged.decision, D.ALLOW);
  assert.equal(unchanged.reason, R.LOW_RISK_ACTION);

  // Already at the floor: the action's own reason stays, no override reason.
  const equal = evaluateToolCall({ action: 'mystery', toolName: 'maybe-do-thing', classifier }, { minimumDecision: 'review' });
  assert.equal(equal.decision, D.REVIEW);
  assert.equal(equal.reason, R.UNKNOWN_ACTION_REVIEW_REQUIRED);
});

test('secret arguments replace the reason of a review the action already required', () => {
  const plain = evaluateToolCall({ action: 'mystery', toolName: 'maybe-do-thing', classifier });
  assert.equal(plain.decision, D.REVIEW);
  assert.equal(plain.reason, R.UNKNOWN_ACTION_REVIEW_REQUIRED);

  const withSecret = evaluateToolCall({ action: 'mystery', toolName: 'maybe-do-thing', args: { token: 'secret' }, classifier });
  assert.equal(withSecret.decision, D.REVIEW);
  assert.equal(withSecret.reason, R.SECRET_ARGS_REVIEW_REQUIRED);
  assert.deepEqual(withSecret.warnings, ['Sensitive arguments detected.']);
});

test('a dry-run-only action keeps its decision; secrets and a missing classifier each set their own reason', () => {
  const withSecret = evaluateToolCall({ action: 'deploy', toolName: 'deploy-thing', args: { token: 'secret' }, classifier });
  assert.equal(withSecret.decision, D.DRY_RUN_ONLY);
  assert.equal(withSecret.reason, R.SECRET_ARGS_REVIEW_REQUIRED);

  const noClassifier = evaluateToolCall({ action: 'deploy', toolName: 'deploy-thing' });
  assert.equal(noClassifier.decision, D.DRY_RUN_ONLY);
  assert.equal(noClassifier.reason, R.REVIEW_REQUIRED);
  assert.deepEqual(noClassifier.warnings, [
    'Missing or malformed AB1 classifier output.',
    'Dry-run-only operation requires simulation.',
  ]);
});

test('a dry-run request only turns an allowed call into dry_run_only', () => {
  const review = evaluateToolCall({ action: 'mystery', toolName: 'maybe-do-thing', classifier });
  assert.equal(review.decision, D.REVIEW);
  assert.equal(review.dryRunOnly, false);
});

test('an action without a tool name is still normalized, so no normalization warning', () => {
  const result = evaluateToolCall({ action: 'read', classifier });
  assert.equal(result.decision, D.ALLOW);
  assert.deepEqual(result.warnings, []);
});

test('normalizeGateDecision accepts no decision at all and fails closed to review', () => {
  for (const input of [undefined, null]) {
    const result = normalizeGateDecision(input);
    assert.equal(result.ok, true);
    assert.equal(result.decision, D.REVIEW);
    assert.equal(result.reason, R.REVIEW_REQUIRED);
    assert.equal(result.allowed, false);
    assert.equal(result.canExecute, false);
    assert.equal(result.canDryRun, true);
    assert.equal(result.requiredReview, true);
    assert.equal(result.dryRunOnly, false);
    assert.deepEqual(result.risk, { level: 'unknown', score: 0.5, category: 'unknown' });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.metadata, { policyVersion: AB2_POLICY_VERSION, workspaceId: 'default' });
  }
});

test('normalizeGateDecision derives every flag from the decision when none is given', () => {
  const expect = {
    allow: { allowed: true, canExecute: true, canDryRun: true, requiredReview: false, dryRunOnly: false },
    dry_run_only: { allowed: false, canExecute: false, canDryRun: true, requiredReview: true, dryRunOnly: true },
    review: { allowed: false, canExecute: false, canDryRun: true, requiredReview: true, dryRunOnly: false },
    block: { allowed: false, canExecute: false, canDryRun: false, requiredReview: true, dryRunOnly: false },
  };
  for (const [decision, flags] of Object.entries(expect)) {
    const result = normalizeGateDecision({ decision });
    const actual = Object.fromEntries(Object.keys(flags).map((key) => [key, result[key]]));
    assert.deepEqual(actual, flags, decision);
  }
});

test('normalizeGateDecision keeps flags a caller set explicitly', () => {
  const result = normalizeGateDecision({
    decision: 'allow', ok: false, allowed: false, canExecute: false, canDryRun: false, requiredReview: true, dryRunOnly: true,
  });
  assert.deepEqual(
    [result.ok, result.allowed, result.canExecute, result.canDryRun, result.requiredReview, result.dryRunOnly],
    [false, false, false, false, true, true],
  );
});
