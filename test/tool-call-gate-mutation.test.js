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

test('classifier extraction accepts top-level, nested and metadata versions with risk synonyms', () => {
  const top = normalizeToolCall({
    action: 'read',
    classifierVersion: 'top-v1',
    risk: { level: 'minimal', score: -1, category: '' },
  });
  assert.deepEqual(top.classifier, {
    classifierVersion: 'top-v1',
    risk: { level: 'low', score: 0, category: 'unknown' },
    valid: true,
  });

  const nested = normalizeToolCall({
    action: 'read',
    classifier: {
      meta: { classifierVersion: 'meta-v2' },
      risk: { level: 'severe', score: 2, category: 'security' },
    },
  });
  assert.deepEqual(nested.classifier, {
    classifierVersion: 'meta-v2',
    risk: { level: 'critical', score: 1, category: 'security' },
    valid: true,
  });

  const riskOnly = normalizeToolCall({
    action: 'read',
    risk: { level: 'moderate', score: '0.4', category: 'read' },
  });
  assert.deepEqual(riskOnly.classifier, {
    classifierVersion: '',
    risk: { level: 'medium', score: 0.4, category: 'read' },
    valid: true,
  });

  assert.equal(normalizeToolCall({ action: 'read' }).classifier, null);
});

test('argument normalization recursively clones arrays and plain objects', () => {
  const source = { nested: [{ x: 1 }, ['y']], scalar: 2 };
  const normalized = normalizeToolCall({ action: 'read', args: source, classifier });
  assert.deepEqual(normalized.args, source);
  assert.notEqual(normalized.args, source);
  assert.notEqual(normalized.args.nested, source.nested);
  assert.notEqual(normalized.args.nested[0], source.nested[0]);
});

test('location directory names never escalate a read but location basenames still can', () => {
  for (const key of [
    'file_path', 'filepath', 'path', 'targetpath', 'target_path', 'destination',
    'dir', 'directory', 'cwd', 'workspaceroot', 'workspace_root',
    'notebook_path', 'notebookpath', 'output_path', 'outputpath',
  ]) {
    const args = { [key]: '/tmp/deploy/release/publish/readme.md' };
    const result = evaluateToolCall({ action: 'read', toolName: 'get-file', args, classifier });
    assert.equal(result.decision, TOOL_GATE_DECISIONS.ALLOW, key);
  }

  const basename = evaluateToolCall({
    action: 'read',
    toolName: 'get-file',
    args: { path: '/tmp/ordinary/deploy.sh' },
    classifier,
  });
  assert.equal(basename.decision, TOOL_GATE_DECISIONS.DRY_RUN_ONLY);
  assert.equal(basename.reason, TOOL_GATE_REASONS.HIGH_RISK_ACTION_DRY_RUN_ONLY);
});

test('warnings are exact for malformed identity, secret args and dry-run-only actions', () => {
  const malformed = evaluateToolCall({ classifier });
  assert.ok(malformed.warnings.includes('Action could not be normalized.'));

  const secret = evaluateToolCall({
    action: 'deploy',
    toolName: 'release',
    args: { token: 'x' },
    classifier,
  });
  assert.ok(secret.warnings.includes('Sensitive arguments detected.'));
  assert.ok(secret.warnings.includes('Dry-run-only operation requires simulation.'));

  const missing = evaluateToolCall({ action: 'deploy', toolName: 'release' });
  assert.ok(missing.warnings.includes('Missing or malformed AB1 classifier output.'));
});

test('normalizeGateDecision respects explicit booleans instead of recomputing them', () => {
  const normalized = normalizeGateDecision({
    ok: false,
    decision: 'allow',
    allowed: false,
    canExecute: false,
    canDryRun: false,
    requiredReview: true,
    dryRunOnly: true,
    risk: { level: 'high', score: 'not-number', category: '' },
    warnings: ['', 'kept', null],
    metadata: { policyVersion: 'p', classifierVersion: 7, workspaceId: '' },
  });
  assert.equal(normalized.ok, false);
  assert.equal(normalized.allowed, false);
  assert.equal(normalized.canExecute, false);
  assert.equal(normalized.canDryRun, false);
  assert.equal(normalized.requiredReview, true);
  assert.equal(normalized.dryRunOnly, true);
  assert.deepEqual(normalized.warnings, ['kept']);
  assert.deepEqual(normalized.risk, { level: 'high', score: 0.5, category: 'unknown' });
  assert.deepEqual(normalized.metadata, {
    policyVersion: 'p',
    classifierVersion: '7',
    workspaceId: 'default',
  });
});

test('tool gate public decision and reason vocabulary is independently pinned', () => {
  assert.equal(AB2_POLICY_VERSION, 'AB2-v0.1.0');
  assert.deepEqual(TOOL_GATE_DECISIONS, {
    ALLOW: 'allow',
    REVIEW: 'review',
    BLOCK: 'block',
    DRY_RUN_ONLY: 'dry_run_only',
  });
  assert.deepEqual(TOOL_GATE_REASONS, {
    LOW_RISK_ACTION: 'LOW_RISK_ACTION',
    REVIEW_REQUIRED: 'REVIEW_REQUIRED',
    CRITICAL_MUTATION_BLOCKED: 'CRITICAL_MUTATION_BLOCKED',
    HIGH_RISK_ACTION_DRY_RUN_ONLY: 'HIGH_RISK_ACTION_DRY_RUN_ONLY',
    UNKNOWN_ACTION_REVIEW_REQUIRED: 'UNKNOWN_ACTION_REVIEW_REQUIRED',
    SECRET_ARGS_REVIEW_REQUIRED: 'SECRET_ARGS_REVIEW_REQUIRED',
    MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
    POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
    POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
    EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED: 'EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED',
    DRY_RUN_REQUESTED: 'DRY_RUN_REQUESTED',
  });
});

test('every read/write/destructive/deploy/side-effect action token keeps its authority class', () => {
  const groups = [
    {
      actions: ['read','get','list','fetch','inspect','view','show','open','query','search','status','describe','check','health'],
      decision: 'allow',
      reason: 'LOW_RISK_ACTION',
    },
    {
      actions: ['write','update','create','set','edit','save','insert','add','modify'],
      decision: 'review',
      reason: 'REVIEW_REQUIRED',
    },
    {
      actions: ['delete','remove','destroy','drop','purge','wipe','truncate','format','reset','erase','revoke','kill','shutdown'],
      decision: 'block',
      reason: 'CRITICAL_MUTATION_BLOCKED',
    },
    {
      actions: ['deploy','publish','release','ship','promote','push','upload'],
      decision: 'dry_run_only',
      reason: 'HIGH_RISK_ACTION_DRY_RUN_ONLY',
    },
    {
      actions: ['send','notify','message','post','email','webhook','call','execute','run','sync','broadcast'],
      decision: 'review',
      reason: 'EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED',
    },
  ];

  for (const group of groups) {
    for (const action of group.actions) {
      const result = evaluateToolCall({ action, toolName: `${action}-tool`, classifier });
      assert.equal(result.decision, group.decision, action);
      assert.equal(result.reason, group.reason, action);
    }
  }
});

test('bare patch is classified by the network-mutation branch, not the generic write branch', () => {
  const result = evaluateToolCall({ action: 'patch', toolName: 'patch-tool', classifier });
  assert.equal(result.decision, 'review');
  assert.equal(result.reason, 'EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED');
  assert.deepEqual(result.risk, { level: 'high', score: 0.85, category: 'external_side_effect' });
});

test('every network mutation phrase escalates payload text with the external-side-effect reason', () => {
  for (const phrase of [
    'post', 'put', 'patch', 'webhook', 'api write', 'external api write',
    'remote update', 'create issue', 'create comment', 'create pull request',
    'create pr', 'payment', 'billing', 'third-party mutation',
  ]) {
    const result = evaluateToolCall({
      action: 'read',
      toolName: 'reader',
      input: `request intends ${phrase} now`,
      classifier,
    });
    assert.equal(result.decision, 'review', phrase);
    assert.equal(result.reason, 'EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED', phrase);
  }
});

test('secret key vocabulary remains fail-closed', () => {
  for (const key of [
    'api_key', 'api-key', 'secret', 'password', 'passwd', 'token',
    'bearer', 'credential', 'private key', 'client_secret', 'client-secret',
  ]) {
    assert.equal(hasSecretLookingValue({ [key]: 'safe-looking-value' }), true, key);
  }
});
