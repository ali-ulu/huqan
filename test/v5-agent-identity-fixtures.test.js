const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureDir = path.join(__dirname, 'fixtures', 'v5', 'agent-identity');

const expectedFixtures = [
  'valid.minimal.json',
  'invalid.missing_agent_id.json',
  'invalid.revoked_identity.json',
  'invalid.expired_identity.json',
  'invalid.workspace_mismatch.json',
  'invalid.broken_delegation_chain.json'
];

const requiredIdentityFields = [
  'agent_id',
  'agent_type',
  'display_name',
  'owner_actor_id',
  'workspace_id',
  'delegation_scope',
  'allowed_tools',
  'allowed_memory_scopes',
  'allowed_connectors',
  'risk_tier',
  'trust_tier',
  'policy_version',
  'issued_at',
  'expires_at',
  'revoked_at',
  'revocation_reason',
  'parent_agent_id',
  'delegation_chain',
  'receipt_refs',
  'provenance_refs',
  'audit_requirements',
  'verification_status'
];

function readFixture(name) {
  const filePath = path.join(fixtureDir, name);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('V5 agent identity fixture files exist and parse', () => {
  for (const fixtureName of expectedFixtures) {
    const filePath = path.join(fixtureDir, fixtureName);
    assert.equal(fs.existsSync(filePath), true, `${fixtureName} should exist`);
    assert.doesNotThrow(() => readFixture(fixtureName), `${fixtureName} should parse`);
  }
});

test('valid minimal fixture contains planned required identity fields', () => {
  const fixture = readFixture('valid.minimal.json');

  for (const field of requiredIdentityFields) {
    assert.ok(Object.hasOwn(fixture, field), `missing required field: ${field}`);
  }

  assert.equal(fixture.expected_status, 'valid');
  assert.equal(fixture.expected_reason_code, null);
});

test('invalid fixtures include expected status and reason code', () => {
  for (const fixtureName of expectedFixtures.filter((name) => name.startsWith('invalid.'))) {
    const fixture = readFixture(fixtureName);

    assert.equal(typeof fixture.expected_status, 'string', `${fixtureName} expected_status`);
    assert.equal(typeof fixture.expected_reason_code, 'string', `${fixtureName} expected_reason_code`);
    assert.notEqual(fixture.expected_reason_code.trim(), '', `${fixtureName} expected_reason_code non-empty`);
  }
});

test('revoked identity fixture encodes revocation evidence', () => {
  const fixture = readFixture('invalid.revoked_identity.json');

  assert.equal(fixture.verification_status, 'revoked');
  assert.equal(fixture.expected_reason_code, 'identity_revoked');
  assert.equal(typeof fixture.revoked_at, 'string');
  assert.notEqual(fixture.revoked_at.trim(), '');
  assert.equal(typeof fixture.revocation_reason, 'string');
  assert.notEqual(fixture.revocation_reason.trim(), '');
});

test('expired identity fixture encodes expiry evidence', () => {
  const fixture = readFixture('invalid.expired_identity.json');

  assert.equal(fixture.verification_status, 'expired');
  assert.equal(fixture.expected_reason_code, 'identity_expired');
  assert.equal(typeof fixture.expires_at, 'string');
  assert.notEqual(fixture.expires_at.trim(), '');
});

test('workspace mismatch fixture encodes a mismatch expectation', () => {
  const fixture = readFixture('invalid.workspace_mismatch.json');

  assert.equal(fixture.expected_reason_code, 'workspace_mismatch');
  assert.equal(typeof fixture.workspace_id, 'string');
  assert.equal(typeof fixture.requested_workspace_id, 'string');
  assert.notEqual(fixture.workspace_id, fixture.requested_workspace_id);
});

test('broken delegation fixture encodes an inconsistent delegation chain', () => {
  const fixture = readFixture('invalid.broken_delegation_chain.json');

  assert.equal(fixture.expected_reason_code, 'broken_delegation_chain');
  assert.equal(typeof fixture.parent_agent_id, 'string');
  assert.equal(Array.isArray(fixture.delegation_chain), true);
  assert.notEqual(fixture.delegation_chain[0], fixture.parent_agent_id);
});

test('fixture test stays isolated from runtime modules', () => {
  const testSource = fs.readFileSync(__filename, 'utf8');
  const forbiddenRuntimeImport = /require\(['"]\.\.\/(?:kernel|server|mcpServer|lib\/|schemas\/|packages\/)/;

  assert.equal(forbiddenRuntimeImport.test(testSource), false);
});
