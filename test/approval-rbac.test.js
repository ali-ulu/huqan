'use strict';

// #4205: the approval RBAC policy is opt-in and fail-closed. With no policy
// none of these refusals exist; with one, every path either finds a role that
// may decide or refuses.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  authorizeApproval,
  loadApprovalRbacPolicy,
  quorumRequiredFor,
  resolveApprovalOperator,
  createOperatorApiKeySalt,
  createOperatorApiKeyVerifier,
  validatePolicy,
  eligibleVotersRemaining,
} = require('../lib/approval-rbac');

const EXAMPLE_PATH = path.join(__dirname, '..', 'config', 'rbac.example.json');
const DOCS_PATH = path.join(__dirname, '..', 'docs', 'rbac.md');

const POLICY = Object.freeze({
  version: 1,
  roles: {
    viewer: [],
    approver: ['approvals.view', 'approvals.decide'],
  },
  operators: { alice: 'approver', bob: 'viewer' },
});

function loaded(overrides = {}) {
  const result = validatePolicy({ ...POLICY, ...overrides });
  assert.equal(result.ok, true, result.reason);
  return result;
}

test('no policy configured leaves the single-user path untouched', () => {
  const policy = loadApprovalRbacPolicy({ readEnvironment: () => undefined });
  assert.deepEqual(policy, { configured: false, ok: true });
  assert.deepEqual(authorizeApproval({ policy, operatorId: undefined }), { ok: true, governed: false });
});

test('a policy is read from the environment path', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-rbac-')), 'policy.json');
  fs.writeFileSync(file, JSON.stringify(POLICY));
  const policy = loadApprovalRbacPolicy({
    readEnvironment: name => (name === 'RBAC_POLICY_PATH' ? file : undefined),
  });
  assert.equal(policy.configured, true);
  assert.equal(policy.ok, true);
  assert.equal(policy.policy.operators.alice, 'approver');
});

test('an unreadable or malformed policy refuses every decision', () => {
  const missing = loadApprovalRbacPolicy({
    readEnvironment: () => path.join(os.tmpdir(), 'huqan-rbac-does-not-exist.json'),
  });
  assert.equal(missing.configured, true);
  assert.equal(missing.ok, false);

  const badJson = loadApprovalRbacPolicy({
    readEnvironment: () => 'policy.json',
    readFile: () => '{not json',
  });
  assert.equal(badJson.ok, false);

  for (const policy of [missing, badJson]) {
    const decision = authorizeApproval({ policy, operatorId: 'alice' });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'APPROVAL_RBAC_POLICY_INVALID');
  }
});

test('the validator refuses structures that could silently widen access', () => {
  const refused = [
    { version: 2 },
    { roles: [] },
    { operators: [] },
    { roles: { approver: ['approvals.decide', 'approvals.everything'] } },
    { roles: { approver: ['approvals.decide', 'approvals.decide'] } },
    { roles: { approver: ['approvals.decide'] }, operators: { alice: 'missing' } },
    { operators: { 'not a valid id': 'approver' } },
    { separationOfDuties: 'yes' },
    { comment: 'extra fields are refused so a typo cannot be ignored' },
  ];
  for (const overrides of refused) {
    const result = validatePolicy({ ...POLICY, ...overrides });
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(typeof result.reason, 'string');
  }
});

test('a decision is allowed only for a known role that grants approvals.decide', () => {
  const policy = loaded();

  const allowed = authorizeApproval({ policy, operatorId: 'alice' });
  assert.deepEqual(allowed, { ok: true, governed: true, operatorId: 'alice', role: 'approver' });

  const missing = authorizeApproval({ policy, operatorId: undefined });
  assert.equal(missing.code, 'APPROVAL_RBAC_OPERATOR_REQUIRED');

  const malformed = authorizeApproval({ policy, operatorId: 'alice ' });
  assert.equal(malformed.code, 'APPROVAL_RBAC_OPERATOR_REQUIRED');

  const unknown = authorizeApproval({ policy, operatorId: 'carol' });
  assert.equal(unknown.code, 'APPROVAL_RBAC_OPERATOR_UNKNOWN');

  const denied = authorizeApproval({ policy, operatorId: 'bob' });
  assert.equal(denied.code, 'APPROVAL_RBAC_PERMISSION_DENIED');
  assert.equal(denied.role, 'viewer');
});

test('quorum policy requires distinct configured approvers and authenticates API keys', () => {
  const aliceKey = 'alice-api-key-'.padEnd(48, 'a');
  const bobKey = 'bob-api-key-'.padEnd(48, 'b');
  const salt = createOperatorApiKeySalt();
  const policy = loaded({
    operators: { alice: 'approver', bob: 'approver' },
    operatorApiKeySalt: salt,
    operatorApiKeyVerifiers: {
      alice: createOperatorApiKeyVerifier(aliceKey, salt),
      bob: createOperatorApiKeyVerifier(bobKey, salt),
    },
    quorum: { default: 1, byTool: { 'huqan.learn': 2 } },
  });
  assert.equal(quorumRequiredFor(policy, 'huqan.learn'), 2);
  assert.equal(quorumRequiredFor(policy, 'huqan.ingest'), 1);
  assert.equal(resolveApprovalOperator({ policy, apiKey: aliceKey, operatorIdHint: 'alice' }).operatorId, 'alice');
  assert.equal(resolveApprovalOperator({ policy, apiKey: bobKey, operatorIdHint: 'bob' }).operatorId, 'bob');
  assert.equal(resolveApprovalOperator({ policy, apiKey: aliceKey, operatorIdHint: 'bob' }).code, 'APPROVAL_RBAC_API_KEY_INVALID');
  assert.equal(resolveApprovalOperator({ policy, apiKey: 'unknown-key'.padEnd(48, 'x'), operatorIdHint: 'alice' }).code, 'APPROVAL_RBAC_API_KEY_INVALID');
  assert.equal(resolveApprovalOperator({ policy, apiKey: aliceKey }).code, 'APPROVAL_RBAC_OPERATOR_REQUIRED');
  assert.equal(resolveApprovalOperator({ policy }).code, 'APPROVAL_RBAC_API_KEY_REQUIRED');
});

test('quorum validation refuses thresholds without enough distinct authorized API keys', () => {
  const aliceKey = 'alice-api-key-'.padEnd(48, 'a');
  const salt = createOperatorApiKeySalt();
  const verifier = createOperatorApiKeyVerifier(aliceKey, salt);
  for (const overrides of [
    { quorum: { default: 2 } },
    { operators: { alice: 'approver', bob: 'approver' }, operatorApiKeySalt: salt,
      operatorApiKeyVerifiers: { alice: verifier }, quorum: { default: 2 } },
    { operatorApiKeyVerifiers: { bob: verifier } },
    { operatorApiKeySalt: salt, operatorApiKeyVerifiers: { alice: 'not-a-verifier' } },
    { operatorApiKeySalt: salt, operatorApiKeyVerifiers: { bob: verifier }, quorum: { default: 1 } },
    { operators: { alice: 'approver', bob: 'approver' }, operatorApiKeySalt: salt,
      operatorApiKeyVerifiers: { alice: verifier, bob: verifier }, quorum: { default: 2 } },
    { quorum: { default: 1.5 } },
  ]) {
    const result = validatePolicy({ ...POLICY, ...overrides });
    assert.equal(result.ok, false, JSON.stringify(overrides));
  }
});

test('the policy hash is canonical and follows the policy it describes', () => {
  const salt = createOperatorApiKeySalt();
  const verifiers = {
    alice: createOperatorApiKeyVerifier('alice-api-key-'.padEnd(48, 'a'), salt),
    bob: createOperatorApiKeyVerifier('bob-api-key-'.padEnd(48, 'b'), salt),
  };
  const operators = { alice: 'approver', bob: 'approver' };
  const shipped = { operators, operatorApiKeySalt: salt, operatorApiKeyVerifiers: verifiers, quorum: { default: 1 } };
  const policy = loaded(shipped);
  assert.match(policy.policy.hash, /^[0-9a-f]{64}$/);
  assert.equal(loaded(Object.fromEntries(Object.entries(shipped).reverse())).policy.hash, policy.policy.hash,
    'object key order is not part of the policy');
  assert.notEqual(loaded({ ...shipped, quorum: { default: 1, byTool: { 'huqan.learn': 2 } } }).policy.hash,
    policy.policy.hash, 'a threshold change changes the hash');
  assert.notEqual(loaded({ ...shipped, separationOfDuties: true }).policy.hash, policy.policy.hash);
  assert.notEqual(loaded({ operators, operatorApiKeySalt: salt, quorum: { default: 1 },
    operatorApiKeyVerifiers: { alice: verifiers.alice,
      bob: createOperatorApiKeyVerifier('bob-api-key-'.padEnd(48, 'c'), salt) } }).policy.hash,
  policy.policy.hash, 'a different credential set changes the hash');
});

test('separation of duties is off by default and compares requester to approver when on', () => {
  const off = loaded();
  assert.equal(off.policy.separationOfDuties, false);
  assert.equal(authorizeApproval({ policy: off, operatorId: 'alice', requesterId: 'alice' }).ok, true);

  const on = loaded({ separationOfDuties: true });
  const same = authorizeApproval({ policy: on, operatorId: 'alice', requesterId: 'alice' });
  assert.equal(same.ok, false);
  assert.equal(same.code, 'APPROVAL_RBAC_SEPARATION_OF_DUTIES');

  assert.equal(authorizeApproval({ policy: on, operatorId: 'alice', requesterId: 'dana' }).ok, true);
  // An approval row with no recorded requester cannot be self-approval.
  assert.equal(authorizeApproval({ policy: on, operatorId: 'alice', requesterId: undefined }).ok, true);
});

test('the example policy is valid and the docs matrix matches it', () => {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  const validated = validatePolicy(example);
  assert.equal(validated.ok, true, validated.reason);

  const markdown = fs.readFileSync(DOCS_PATH, 'utf8');
  const start = markdown.indexOf('## Role matrix');
  assert.notEqual(start, -1, 'docs/rbac.md keeps its Role matrix section');
  const end = markdown.indexOf('\n## ', start + 1);
  const section = markdown.slice(start, end === -1 ? undefined : end);
  const rows = section.split('\n').filter(line => /^\| `[^`]+` \|/.test(line));
  assert.equal(rows.length, Object.keys(example.roles).length, 'one matrix row per role');

  for (const [role, permissions] of Object.entries(example.roles)) {
    const row = rows.find(line => line.startsWith(`| \`${role}\` |`));
    assert.ok(row, `docs/rbac.md has a row for ${role}`);
    if (permissions.length === 0) {
      assert.match(row, /\| none \|/, `${role} has no permission`);
      continue;
    }
    for (const permission of permissions) {
      assert.ok(row.includes(`\`${permission}\``), `${role} must list ${permission}`);
    }
    const documented = [...row.matchAll(/`(approvals\.[a-z]+)`/g)].map(match => match[1]);
    assert.deepEqual([...new Set(documented)].sort(), [...permissions].sort(), `${role} matrix row drifted`);
  }
});

test('eligibleVotersRemaining reports who can still vote', () => {
  const salt = createOperatorApiKeySalt();
  const policy = loaded({
    operators: { alice: 'approver', bob: 'approver', carol: 'viewer' },
    operatorApiKeySalt: salt,
    operatorApiKeyVerifiers: {
      alice: createOperatorApiKeyVerifier('k1'.padEnd(48, 'a'), salt),
      bob: createOperatorApiKeyVerifier('k2'.padEnd(48, 'b'), salt),
    },
    quorum: { default: 2 },
  });
  assert.equal(eligibleVotersRemaining(null, ['alice', 'bob'], []), null);
  assert.deepEqual(eligibleVotersRemaining(policy, undefined, []), []);
  assert.deepEqual(eligibleVotersRemaining(policy, ['alice', 'bob'], []), ['alice', 'bob']);
  assert.deepEqual(eligibleVotersRemaining(policy, ['alice', 'bob'], ['alice']), ['bob']);
  assert.deepEqual(eligibleVotersRemaining(policy, ['alice', 'bob'], ['alice', 'bob']), []);
  // carol is not an approver but appears on the eligible list; she is still listed until she votes
  assert.deepEqual(eligibleVotersRemaining(policy, ['alice', 'carol'], []), ['alice', 'carol']);
});
