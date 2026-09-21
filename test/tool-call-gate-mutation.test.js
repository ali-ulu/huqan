'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AB2_POLICY_VERSION,
  TOOL_GATE_DECISIONS,
  TOOL_GATE_REASONS,
  normalizeToolCall,
  normalizeGateDecision,
  hasSecretLookingValue,
  redactSecretValues,
  evaluateToolCall,
} = require('../lib/tool-call-gate');

const classifier = {
  classifierVersion: 'AB1-test',
  risk: { level: 'low', score: 0.2, category: 'read' },
  valid: true,
};

test('normalizeToolCall pins every accepted alias and policy default', () => {
  const normalized = normalizeToolCall({
    operation: ' READ ',
    name: 'tool-a',
    parameters: { x: 1 },
    workspace: 'ws-a',
    simulate: true,
    gatePolicy: { version: 'policy-x', decision: 'block', metadata: { workspaceId: 'policy-ws' } },
    ab1: { version: 'AB1-x', risk: { level: 'moderate', score: 0.4, category: 'cat' } },
  });
  assert.equal(normalized.action, 'read');
  assert.equal(normalized.actionRaw, 'READ');
  assert.equal(normalized.toolName, 'tool-a');
  assert.deepEqual(normalized.args, { x: 1 });
  assert.equal(normalized.workspaceId, 'ws-a');
  assert.equal(normalized.dryRun, true);
  assert.equal(normalized.policy.policyVersion, 'policy-x');
  assert.equal(normalized.policy.minimumDecision, TOOL_GATE_DECISIONS.BLOCK);
  assert.equal(normalized.policy.workspaceId, 'policy-ws');
  assert.equal(normalized.classifier.classifierVersion, 'AB1-x');
  assert.deepEqual(normalized.classifier.risk, { level: 'medium', score: 0.4, category: 'cat' });

  const defaults = normalizeToolCall({});
  assert.equal(defaults.action, '');
  assert.equal(defaults.toolName, '');
  assert.equal(defaults.args, null);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.workspaceId, 'default');
  assert.equal(defaults.policy.policyVersion, AB2_POLICY_VERSION);
  assert.equal(defaults.policy.minimumDecision, '');
});

test('secret detection handles key names, values, arrays, locations and cycles', () => {
  assert.equal(hasSecretLookingValue({ apiKey: 'anything' }), true);
  assert.equal(hasSecretLookingValue({ nested: [{ password: 'x' }] }), true);
  assert.equal(hasSecretLookingValue({ value: 'Bearer abcdefghijklmnopqrstuvwxyz' }), true);
  assert.equal(hasSecretLookingValue({ path: '/tmp/tokens/readme.md' }), false);
  assert.equal(hasSecretLookingValue({ path: '/tmp/api_key.txt' }), true);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(hasSecretLookingValue(cyclic), false);
});

test('redaction preserves safe structure and fails closed for secret keys and circular values', () => {
  const input = {
    ok: 'safe',
    apiKey: 'secret',
    nested: [{ password: 'pw' }, 'safe'],
  };
  assert.deepEqual(redactSecretValues(input), {
    ok: 'safe',
    apiKey: '[REDACTED]',
    nested: [{ password: '[REDACTED]' }, 'safe'],
  });

  const cyclic = { safe: 1 };
  cyclic.self = cyclic;
  assert.deepEqual(redactSecretValues(cyclic), { safe: 1, self: '[CIRCULAR]' });
});

test('normalizeGateDecision pins fail-closed defaults and numeric clamping', () => {
  const empty = normalizeGateDecision({});
  assert.equal(empty.ok, true);
  assert.equal(empty.allowed, false);
  assert.equal(empty.canExecute, false);
  assert.equal(empty.canDryRun, true);
  assert.equal(empty.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(empty.reason, TOOL_GATE_REASONS.REVIEW_REQUIRED);
  assert.deepEqual(empty.risk, { level: 'unknown', score: 0.5, category: 'unknown' });
  assert.equal(empty.requiredReview, true);
  assert.equal(empty.dryRunOnly, false);
  assert.deepEqual(empty.warnings, []);
  assert.deepEqual(empty.metadata, { policyVersion: AB2_POLICY_VERSION, workspaceId: 'default' });

  const clamped = normalizeGateDecision({
    decision: 'allow',
    risk: { level: 'critical', score: 99, category: 'x' },
  });
  assert.equal(clamped.risk.score, 1);
  assert.equal(clamped.allowed, true);
});

test('decision precedence is exact for missing classifier, secrets, dry-run and critical action', () => {
  const missing = evaluateToolCall({ action: 'read', toolName: 'list-files' });
  assert.equal(missing.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(missing.reason, TOOL_GATE_REASONS.REVIEW_REQUIRED);

  const secret = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    args: { token: 'secret' },
    classifier,
  });
  assert.equal(secret.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(secret.reason, TOOL_GATE_REASONS.SECRET_ARGS_REVIEW_REQUIRED);

  const dry = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    dryRun: true,
    classifier,
  });
  assert.equal(dry.decision, TOOL_GATE_DECISIONS.DRY_RUN_ONLY);
  assert.equal(dry.reason, TOOL_GATE_REASONS.DRY_RUN_REQUESTED);

  const critical = evaluateToolCall({
    action: 'delete',
    toolName: 'remove-user',
    args: { token: 'secret' },
    dryRun: true,
    classifier,
  });
  assert.equal(critical.decision, TOOL_GATE_DECISIONS.BLOCK);
  assert.equal(critical.reason, TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED);
  assert.equal(critical.canDryRun, false);
});

test('policy floor can only raise authority and emits the exact override reason', () => {
  const review = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    classifier,
  }, { minimumDecision: 'review' });
  assert.equal(review.decision, TOOL_GATE_DECISIONS.REVIEW);
  assert.equal(review.reason, TOOL_GATE_REASONS.POLICY_OVERRIDE_REVIEW);

  const block = evaluateToolCall({
    action: 'read',
    toolName: 'list-files',
    classifier,
  }, { minimumDecision: 'block' });
  assert.equal(block.decision, TOOL_GATE_DECISIONS.BLOCK);
  assert.equal(block.reason, TOOL_GATE_REASONS.POLICY_OVERRIDE_BLOCK);

  const cannotLower = evaluateToolCall({
    action: 'delete',
    toolName: 'remove-user',
    classifier,
  }, { minimumDecision: 'allow' });
  assert.equal(cannotLower.decision, TOOL_GATE_DECISIONS.BLOCK);
  assert.equal(cannotLower.reason, TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED);
});
