'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ACTION_CATEGORIES,
  ACTION_DECISIONS,
  RISK_LEVELS,
  FLAGS,
  SECURITY_SENSITIVE_PATH_TOKENS,
  normalizeActionType,
  normalizeActionRequest,
  classifyActionCategory,
  resolveRiskLevel,
  deriveDecision,
  applyHardBlockRules,
  classifyAgentAction,
  normalizeActionDecision,
  normalizeDecision,
  isPathInList,
  isPathSecuritySensitive,
  isUrlInList,
} = require('../lib/risk-classify');
const { CATEGORY_ALIASES, RISK_BY_CATEGORY } = require('../lib/risk-policy-constants');

test('every category alias normalizes to its declared canonical category', () => {
  for (const [alias, category] of Object.entries(CATEGORY_ALIASES)) {
    assert.equal(normalizeActionType(alias), category, alias);
    assert.equal(normalizeActionType(alias.toLowerCase().replaceAll('_', '-')), category, alias);
  }
  assert.equal(normalizeActionType(null), null);
  assert.equal(normalizeActionType(''), null);
  assert.equal(normalizeActionType('not-a-category'), null);
});

test('risk level and decision derivation pin every category and risk tier', () => {
  for (const category of Object.values(ACTION_CATEGORIES)) {
    assert.equal(resolveRiskLevel(category), RISK_BY_CATEGORY[category], category);
  }
  assert.equal(resolveRiskLevel(null), RISK_LEVELS.HIGH);
  assert.equal(resolveRiskLevel('UNKNOWN'), RISK_LEVELS.HIGH);

  assert.equal(deriveDecision(RISK_LEVELS.LOW, false), ACTION_DECISIONS.ALLOW);
  assert.equal(deriveDecision(RISK_LEVELS.MEDIUM, false), ACTION_DECISIONS.QUARANTINE);
  assert.equal(deriveDecision(RISK_LEVELS.HIGH, false), ACTION_DECISIONS.HUMAN_REVIEW);
  assert.equal(deriveDecision(RISK_LEVELS.CRITICAL, false), ACTION_DECISIONS.BLOCK);
  assert.equal(deriveDecision('bogus', false), ACTION_DECISIONS.HUMAN_REVIEW);
  assert.equal(deriveDecision(RISK_LEVELS.LOW, true), ACTION_DECISIONS.BLOCK);
});

test('path allowlist and security-sensitive checks enforce segment boundaries', () => {
  assert.equal(isPathInList('docs/a/b.md', ['docs']), true);
  assert.equal(isPathInList('docs', ['docs']), true);
  assert.equal(isPathInList('docs2/a.md', ['docs']), false);
  assert.equal(isPathInList('/root/a/../secret.txt', ['/root/a']), false);
  assert.equal(isPathInList('', ['docs']), false);
  assert.equal(isPathInList('docs/a', []), false);

  for (const token of SECURITY_SENSITIVE_PATH_TOKENS) {
    assert.equal(isPathSecuritySensitive(token), true, token);
    assert.equal(isPathSecuritySensitive(`prefix/${token.toUpperCase()}`), true, token);
    assert.equal(isPathSecuritySensitive(`not${token}`), false, token);
    assert.equal(isPathSecuritySensitive(`${token}.bak`), false, token);
  }
  assert.equal(isPathSecuritySensitive(''), false);
});

test('URL allowlist requires protocol, host and path boundaries and rejects encoded separators', () => {
  assert.equal(isUrlInList('https://example.com/api', ['https://example.com/api']), true);
  assert.equal(isUrlInList('https://example.com/api/v1', ['https://example.com/api']), true);
  assert.equal(isUrlInList('http://example.com/api', ['https://example.com/api']), false);
  assert.equal(isUrlInList('https://other.example.com/api', ['https://example.com/api']), false);
  assert.equal(isUrlInList('https://example.com/apix', ['https://example.com/api']), false);
  assert.equal(isUrlInList('https://example.com/api%2fadmin', ['https://example.com/api']), false);
  assert.equal(isUrlInList('not a url', ['https://example.com/api']), false);
  assert.equal(isUrlInList('https://example.com/api', []), false);
});

test('action request normalization pins aliases, flag aliases and malformed handling', () => {
  const malformed = normalizeActionRequest(null);
  assert.equal(malformed.malformed, true);
  assert.deepEqual(malformed.flags, [FLAGS.MALFORMED_ACTION]);
  assert.equal(classifyActionCategory(null), null);

  const normalized = normalizeActionRequest({
    type: 'read',
    action: 'inspect',
    target: 'x',
    context: { flags: ['auto-deployment', 'real-db'] },
    flags: ['auto_merge_requested', 'self-escalate', 'bypass-admission', 'explicit_human_approval'],
    timestamp: 123,
  });
  assert.equal(normalized.malformed, false);
  assert.equal(normalized.category, ACTION_CATEGORIES.READ_ONLY);
  assert.deepEqual(normalized.target, { value: 'x' });
  assert.deepEqual(normalized.flags.sort(), [
    FLAGS.AUTO_DEPLOY,
    FLAGS.AUTO_MERGE,
    FLAGS.BYPASS_ADMISSION,
    FLAGS.EXPLICIT_HUMAN_APPROVAL,
    FLAGS.REAL_DB,
    FLAGS.SELF_ESCALATION,
  ].sort());
  assert.equal(normalized.now, 123);
});

test('hard-block rules independently block every safety override', () => {
  const base = {
    category: ACTION_CATEGORIES.READ_ONLY,
    riskLevel: RISK_LEVELS.LOW,
    decision: ACTION_DECISIONS.ALLOW,
    flags: [],
    reasons: [],
    hardBlocked: false,
    target: null,
  };
  for (const flag of [FLAGS.AUTO_MERGE, FLAGS.AUTO_DEPLOY, FLAGS.SELF_ESCALATION]) {
    const out = applyHardBlockRules({ flags: [flag] }, { ...base, flags: [], reasons: [] });
    assert.equal(out.decision, ACTION_DECISIONS.BLOCK, flag);
    assert.equal(out.riskLevel, RISK_LEVELS.CRITICAL, flag);
    assert.equal(out.hardBlocked, true, flag);
    assert.ok(out.flags.includes(FLAGS.HARD_BLOCKED), flag);
  }

  for (const category of [
    ACTION_CATEGORIES.SECURITY_POLICY_CHANGE,
    ACTION_CATEGORIES.DEPLOYMENT,
    ACTION_CATEGORIES.PERMISSION_CHANGE,
    ACTION_CATEGORIES.PRODUCTION_MUTATION,
  ]) {
    const out = applyHardBlockRules({}, { ...base, category, flags: [], reasons: [] });
    assert.equal(out.decision, ACTION_DECISIONS.BLOCK, category);
    assert.equal(out.hardBlocked, true, category);
  }
});

test('normalization of external decisions preserves full safety shape and fail-closed fallback', () => {
  const malformed = normalizeActionDecision(null);
  assert.equal(malformed.riskLevel, RISK_LEVELS.HIGH);
  assert.equal(malformed.decision, ACTION_DECISIONS.HUMAN_REVIEW);
  assert.deepEqual(malformed.flags, [FLAGS.MALFORMED_ACTION]);
  assert.equal(malformed.reason, 'Malformed action input');

  const normalized = normalizeActionDecision({
    actionType: 'read',
    category: 'read',
    actionCategory: 'read',
    riskLevel: 'low',
    decision: 'allow',
    reasons: ['first', 'first', 'second'],
    flags: ['x', 'x'],
    target: 't',
  });
  assert.equal(normalized.actionType, ACTION_CATEGORIES.READ_ONLY);
  assert.equal(normalized.riskLevel, RISK_LEVELS.LOW);
  assert.equal(normalized.decision, ACTION_DECISIONS.ALLOW);
  assert.deepEqual(normalized.reasons, ['first', 'second']);
  assert.deepEqual(normalized.flags, ['x']);
  assert.deepEqual(normalized.target, { value: 't' });
  assert.equal(normalized.reason, 'first');

  assert.equal(normalizeDecision(' allow '), ACTION_DECISIONS.ALLOW);
  assert.equal(normalizeDecision('not-real'), ACTION_DECISIONS.HUMAN_REVIEW);
});

test('representative classifyAgentAction hard blocks and allowlist outcomes are exact', () => {
  const read = classifyAgentAction({ category: 'read', action: 'read', target: { path: 'docs/a.md' } }, {
    allowlistedPaths: ['docs'],
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(read.decision, ACTION_DECISIONS.ALLOW);
  assert.equal(read.riskLevel, RISK_LEVELS.LOW);
  assert.equal(read.reason, 'Read-only action stays low risk.');
  assert.equal(read.requiredReview, false);
  assert.equal(read.blocked, false);

  const outside = classifyAgentAction({ category: 'read', target: { path: 'secret/a.md' } }, {
    allowlistedPaths: ['docs'],
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(outside.decision, ACTION_DECISIONS.HUMAN_REVIEW);
  assert.ok(outside.flags.includes(FLAGS.PATH_OUTSIDE_ALLOWLIST));

  const prod = classifyAgentAction({ category: 'memory_write', target: { env: 'production' } }, {
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(prod.decision, ACTION_DECISIONS.BLOCK);
  assert.equal(prod.hardBlocked, true);
  assert.ok(prod.flags.includes(FLAGS.PRODUCTION_SIDE));
});
