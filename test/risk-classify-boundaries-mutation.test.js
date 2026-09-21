'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ACTION_CATEGORIES,
  ACTION_DECISIONS,
  RISK_LEVELS,
  FLAGS,
  SECURITY_SENSITIVE_PATH_TOKENS,
  POLICY_VERSION,
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

test('every supported flag alias normalizes to the exact canonical safety flag', () => {
  const aliases = new Map([
    ['auto_merge', FLAGS.AUTO_MERGE],
    ['auto_merge_requested', FLAGS.AUTO_MERGE],
    ['auto-deploy', FLAGS.AUTO_DEPLOY],
    ['auto_deployment', FLAGS.AUTO_DEPLOY],
    ['self_escalation', FLAGS.SELF_ESCALATION],
    ['self-escalate', FLAGS.SELF_ESCALATION],
    ['malformed_action', FLAGS.MALFORMED_ACTION],
    ['unknown_action_category', FLAGS.UNKNOWN_ACTION_CATEGORY],
    ['path_security_sensitive', FLAGS.PATH_SECURITY_SENSITIVE],
    ['path_outside_allowlist', FLAGS.PATH_OUTSIDE_ALLOWLIST],
    ['url_outside_allowlist', FLAGS.URL_OUTSIDE_ALLOWLIST],
    ['production_side', FLAGS.PRODUCTION_SIDE],
    ['production', FLAGS.PRODUCTION_SIDE],
    ['bypass_admission', FLAGS.BYPASS_ADMISSION],
    ['real_db', FLAGS.REAL_DB],
    ['ungated', FLAGS.UNGATED_TOOL_CHAIN],
    ['ungated_tool_chain', FLAGS.UNGATED_TOOL_CHAIN],
    ['explicit_human_approval', FLAGS.EXPLICIT_HUMAN_APPROVAL],
  ]);
  for (const [input, expected] of aliases) {
    const normalized = normalizeActionRequest({ category: 'read', flags: [input] });
    assert.deepEqual(normalized.flags, [expected], input);
  }

  const unknown = normalizeActionRequest({ category: 'read', flags: ['custom-flag'] });
  assert.deepEqual(unknown.flags, ['custom-flag']);
});

test('action target and timestamp normalization cover primitive and Date inputs', () => {
  const stringTarget = normalizeActionRequest({ category: 'read', target: 'resource' });
  assert.deepEqual(stringTarget.target, { value: 'resource' });

  const numericTarget = normalizeActionRequest({ category: 'read', target: 7 });
  assert.deepEqual(numericTarget.target, { value: '7' });

  const date = new Date('2026-01-01T00:00:00.000Z');
  const classifiedDate = classifyAgentAction({ category: 'read', now: date });
  assert.equal(classifiedDate.trustReceipt.timestamp, date.toISOString());

  const classifiedNumber = classifyAgentAction({ category: 'read', timestamp: 0 });
  assert.equal(classifiedNumber.trustReceipt.timestamp, '1970-01-01T00:00:00.000Z');

  const classifiedBadDate = classifyAgentAction({ category: 'read', now: new Date('invalid') });
  assert.equal(classifiedBadDate.trustReceipt.timestamp, null);
});

test('filesystem, network, sandbox and tool-chain rules pin all three-way outcomes', () => {
  const fsSensitive = classifyAgentAction({
    category: 'filesystem_write', target: { path: 'lib/risk-rules.js' },
  });
  assert.equal(fsSensitive.decision, ACTION_DECISIONS.BLOCK);
  assert.ok(fsSensitive.flags.includes(FLAGS.PATH_SECURITY_SENSITIVE));

  const fsAllowed = classifyAgentAction({
    category: 'filesystem_write', target: { path: 'tmp/file.txt' },
  }, { allowlistedPaths: ['tmp'] });
  assert.equal(fsAllowed.decision, ACTION_DECISIONS.QUARANTINE);

  const fsUnknown = classifyAgentAction({
    category: 'filesystem_write', target: { path: 'elsewhere/file.txt' },
  }, { allowlistedPaths: ['tmp'] });
  assert.equal(fsUnknown.decision, ACTION_DECISIONS.HUMAN_REVIEW);
  assert.ok(fsUnknown.flags.includes(FLAGS.PATH_OUTSIDE_ALLOWLIST));

  const netAllowed = classifyAgentAction({
    category: 'network_call', target: { url: 'https://example.com/api/v1' },
  }, { allowlistedUrls: ['https://example.com/api'] });
  assert.equal(netAllowed.decision, ACTION_DECISIONS.QUARANTINE);

  const netUnknown = classifyAgentAction({
    category: 'network_call', target: { url: 'https://other.example.com/api' },
  }, { allowlistedUrls: ['https://example.com/api'] });
  assert.equal(netUnknown.decision, ACTION_DECISIONS.HUMAN_REVIEW);
  assert.ok(netUnknown.flags.includes(FLAGS.URL_OUTSIDE_ALLOWLIST));

  const sandbox = classifyAgentAction({ category: 'sandbox_simulation', flags: ['real_db'] });
  assert.equal(sandbox.decision, ACTION_DECISIONS.BLOCK);
  assert.ok(sandbox.flags.includes(FLAGS.REAL_DB));

  const chain = classifyAgentAction({ category: 'tool_chain_execution', flags: ['ungated'] });
  assert.equal(chain.decision, ACTION_DECISIONS.BLOCK);
  assert.ok(chain.flags.includes(FLAGS.UNGATED_TOOL_CHAIN));
});


test('mutation sentinels pin optional hard-block inputs, exact reasons and category guards', () => {
  const base = {
    category: ACTION_CATEGORIES.READ_ONLY,
    riskLevel: RISK_LEVELS.LOW,
    decision: ACTION_DECISIONS.ALLOW,
    flags: [],
    reasons: [],
    hardBlocked: false,
    target: null,
  };

  const untouched = applyHardBlockRules(undefined, { ...base, flags: [], reasons: [] });
  assert.equal(untouched.decision, ACTION_DECISIONS.ALLOW);
  assert.equal(untouched.hardBlocked, false);
  assert.deepEqual(untouched.flags, []);
  assert.deepEqual(untouched.reasons, []);

  const cases = [
    [FLAGS.AUTO_MERGE, 'Auto-merge is blocked.'],
    [FLAGS.AUTO_DEPLOY, 'Auto-deploy is blocked.'],
    [FLAGS.SELF_ESCALATION, 'Self-escalation is blocked.'],
  ];
  for (const [flag, reason] of cases) {
    const out = applyHardBlockRules({ flags: [flag] }, { ...base, flags: [], reasons: [] });
    assert.equal(out.decision, ACTION_DECISIONS.BLOCK, flag);
    assert.equal(out.hardBlocked, true, flag);
    assert.equal(out.riskLevel, RISK_LEVELS.CRITICAL, flag);
    assert.deepEqual(out.flags, [flag, FLAGS.HARD_BLOCKED], flag);
    assert.deepEqual(out.reasons, [reason], flag);
  }

  const security = applyHardBlockRules({}, {
    ...base,
    category: ACTION_CATEGORIES.SECURITY_POLICY_CHANGE,
    flags: [],
    reasons: [],
  });
  assert.deepEqual(security.flags, [FLAGS.HARD_BLOCKED]);
  assert.deepEqual(security.reasons, ['Security policy changes default to block.']);

  const production = applyHardBlockRules({}, {
    ...base,
    category: ACTION_CATEGORIES.DEPLOYMENT,
    flags: [],
    reasons: [],
  });
  assert.deepEqual(production.flags, [FLAGS.HARD_BLOCKED]);
  assert.deepEqual(production.reasons, ['Production-side mutation is blocked.']);

  const admission = applyHardBlockRules({ flags: [FLAGS.BYPASS_ADMISSION] }, {
    ...base,
    category: ACTION_CATEGORIES.MEMORY_WRITE,
    flags: [],
    reasons: [],
  });
  assert.deepEqual(admission.flags, [FLAGS.BYPASS_ADMISSION, FLAGS.HARD_BLOCKED, FLAGS.PRODUCTION_SIDE]);
  assert.deepEqual(admission.reasons, ['Admission bypass or production-side target is blocked.']);

  const sandbox = applyHardBlockRules({ flags: [FLAGS.REAL_DB] }, {
    ...base,
    category: ACTION_CATEGORIES.SANDBOX_SIMULATION,
    flags: [],
    reasons: [],
  });
  assert.deepEqual(sandbox.flags, [FLAGS.REAL_DB, FLAGS.HARD_BLOCKED]);
  assert.deepEqual(sandbox.reasons, ['Sandbox must not write to a real DB.']);

  const chain = applyHardBlockRules({ flags: [FLAGS.UNGATED_TOOL_CHAIN] }, {
    ...base,
    category: ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION,
    flags: [],
    reasons: [],
  });
  assert.deepEqual(chain.flags, [FLAGS.UNGATED_TOOL_CHAIN, FLAGS.HARD_BLOCKED]);
  assert.deepEqual(chain.reasons, ['Tool-chain execution must be gated.']);

  const unrelatedUngated = applyHardBlockRules({ flags: [FLAGS.UNGATED_TOOL_CHAIN] }, {
    ...base,
    category: ACTION_CATEGORIES.READ_ONLY,
    flags: [],
    reasons: [],
  });
  assert.equal(unrelatedUngated.decision, ACTION_DECISIONS.ALLOW);
  assert.equal(unrelatedUngated.hardBlocked, false);
  assert.deepEqual(unrelatedUngated.flags, [FLAGS.UNGATED_TOOL_CHAIN]);
  assert.deepEqual(unrelatedUngated.reasons, []);
});

test('malformed, unknown and option-derived classification contracts are exact', () => {
  const malformed = classifyAgentAction(null, {
    flags: [FLAGS.AUTO_DEPLOY],
    now: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(malformed.category, null);
  assert.equal(malformed.action, null);
  assert.equal(malformed.riskLevel, RISK_LEVELS.HIGH);
  assert.equal(malformed.decision, ACTION_DECISIONS.HUMAN_REVIEW);
  assert.equal(malformed.hardBlocked, false);
  assert.equal(malformed.reason, 'Malformed action input');
  assert.deepEqual(malformed.reasons, ['Malformed action input']);
  assert.deepEqual([...malformed.flags].sort(), [FLAGS.MALFORMED_ACTION, FLAGS.AUTO_DEPLOY].sort());
  assert.equal(malformed.trustReceipt.reason, 'Malformed action input');
  assert.equal(malformed.trustReceipt.timestamp, '2026-02-01T00:00:00.000Z');

  const unknown = classifyAgentAction({
    category: 'not-real',
    action: 'probe',
    flags: ['custom'],
    now: '2026-02-02T00:00:00.000Z',
  }, {
    context: { flags: [FLAGS.SELF_ESCALATION] },
  });
  assert.equal(unknown.category, null);
  assert.equal(unknown.action, 'probe');
  assert.equal(unknown.riskLevel, RISK_LEVELS.HIGH);
  assert.equal(unknown.decision, ACTION_DECISIONS.HUMAN_REVIEW);
  assert.equal(unknown.reason, 'Unknown action category');
  assert.deepEqual(unknown.reasons, ['Unknown action category']);
  assert.deepEqual([...unknown.flags].sort(), ['custom', FLAGS.SELF_ESCALATION, FLAGS.UNKNOWN_ACTION_CATEGORY].sort());
  assert.equal(unknown.trustReceipt.reason, 'Unknown action category');
  assert.equal(unknown.trustReceipt.timestamp, '2026-02-02T00:00:00.000Z');

  const optionFlag = classifyAgentAction({ category: 'read' }, {
    context: { flags: [FLAGS.AUTO_MERGE] },
    now: '2026-02-03T00:00:00.000Z',
  });
  assert.equal(optionFlag.decision, ACTION_DECISIONS.BLOCK);
  assert.equal(optionFlag.hardBlocked, true);
  assert.ok(optionFlag.flags.includes(FLAGS.AUTO_MERGE));
  assert.ok(optionFlag.flags.includes(FLAGS.HARD_BLOCKED));
  assert.ok(optionFlag.reasons.includes('Auto-merge is blocked.'));
  assert.equal(optionFlag.trustReceipt.timestamp, '2026-02-03T00:00:00.000Z');

  const inputTime = classifyAgentAction({
    category: 'read',
    now: '2026-02-04T00:00:00.000Z',
  }, {
    now: '2026-02-05T00:00:00.000Z',
  });
  assert.equal(inputTime.trustReceipt.timestamp, '2026-02-05T00:00:00.000Z');
});


test('mutation survivor sentinels pin immutability and normalization edge cases', () => {
  const classified = classifyAgentAction(
    { category: 'read', target: { path: 'docs/nested/item.md' } },
    { allowlistedPaths: ['docs'], now: '2026-03-01T00:00:00.000Z' },
  );
  assert.equal(Object.isFrozen(classified), true);
  assert.equal(Object.isFrozen(classified.flags), true);
  assert.equal(Object.isFrozen(classified.reasons), true);
  assert.equal(Object.isFrozen(classified.target), true);
  assert.equal(Object.isFrozen(classified.trustReceipt), true);
  assert.equal(Object.isFrozen(classified.trustReceipt.flags), true);
  assert.equal(Object.isFrozen(classified.trustReceipt.reasons), true);
  assert.equal(Object.isFrozen(classified.trustReceipt.target), true);

  assert.equal(normalizeActionType('  read-only  '), ACTION_CATEGORIES.READ_ONLY);
  assert.equal(normalizeActionType('tool---chain   execution'), ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION);
  assert.equal(normalizeActionType('   '), null);
  assert.equal(normalizeActionType(undefined), null);

  assert.equal(isPathInList('  docs\\nested//item.md  ', ['docs']), true);
  assert.equal(isPathInList('.', ['docs']), false);
  assert.equal(isUrlInList('  https://example.com/api/v1  ', [' https://example.com/api ']), true);
  assert.equal(isUrlInList(7, ['https://example.com']), false);
  assert.equal(isUrlInList('   ', ['https://example.com']), false);
});

test('mutation survivor sentinels pin decision fallback precedence and metadata', () => {
  const explicit = normalizeActionDecision({
    ok: false,
    actionType: 'read',
    category: 'memory_write',
    actionCategory: 'code_change',
    riskLevel: ' low ',
    decision: ' allow ',
    reasons: ['fallback reason'],
    flags: ['custom'],
    hardBlocked: false,
    policyVersion: 'custom-policy',
    reason: 'explicit reason',
  });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.actionType, ACTION_CATEGORIES.READ_ONLY);
  assert.equal(explicit.category, ACTION_CATEGORIES.MEMORY_WRITE);
  assert.equal(explicit.actionCategory, ACTION_CATEGORIES.CODE_CHANGE);
  assert.equal(explicit.riskLevel, RISK_LEVELS.LOW);
  assert.equal(explicit.decision, ACTION_DECISIONS.ALLOW);
  assert.equal(explicit.policyVersion, 'custom-policy');
  assert.equal(explicit.reason, 'explicit reason');
  assert.deepEqual(explicit.reasons, ['fallback reason']);
  assert.deepEqual(explicit.flags, ['custom']);

  const fallback = normalizeActionDecision({
    actionCategory: 'test_change',
    riskLevel: 7,
    decision: 7,
    reasons: ['first', '', 'first'],
    flags: ['', 'x', 'x'],
    policyVersion: 7,
    reason: 7,
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.actionType, ACTION_CATEGORIES.TEST_CHANGE);
  assert.equal(fallback.category, ACTION_CATEGORIES.TEST_CHANGE);
  assert.equal(fallback.actionCategory, ACTION_CATEGORIES.TEST_CHANGE);
  assert.equal(fallback.riskLevel, RISK_LEVELS.HIGH);
  assert.equal(fallback.decision, ACTION_DECISIONS.HUMAN_REVIEW);
  assert.equal(fallback.policyVersion, POLICY_VERSION);
  assert.equal(fallback.reason, 'first');
  assert.deepEqual(fallback.reasons, ['first']);
  assert.deepEqual(fallback.flags, ['x']);

  const malformed = normalizeActionDecision(null);
  assert.equal(malformed.ok, true);
  assert.equal(malformed.hardBlocked, false);
  assert.deepEqual(malformed.reasons, []);
  assert.deepEqual(malformed.flags, [FLAGS.MALFORMED_ACTION]);
  assert.equal(malformed.policyVersion, POLICY_VERSION);
  assert.equal(malformed.trustReceipt.hardBlocked, false);
  assert.deepEqual(malformed.trustReceipt.reasons, []);
  assert.deepEqual(malformed.trustReceipt.flags, [FLAGS.MALFORMED_ACTION]);
  assert.equal(malformed.trustReceipt.reason, 'Malformed action input');
});

test('mutation survivor sentinels pin every production target vocabulary token', () => {
  for (const value of ['prod', 'production', 'live', 'canonical']) {
    const out = classifyAgentAction({
      category: ACTION_CATEGORIES.MEMORY_WRITE,
      target: { env: `  ${value.toUpperCase()}  ` },
    });
    assert.equal(out.decision, ACTION_DECISIONS.BLOCK, value);
    assert.equal(out.hardBlocked, true, value);
    assert.ok(out.flags.includes(FLAGS.PRODUCTION_SIDE), value);
    assert.ok(out.flags.includes(FLAGS.HARD_BLOCKED), value);
    assert.ok(out.reasons.includes('Admission bypass or production-side target is blocked.'), value);
  }
});
