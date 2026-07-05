const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schemaPath = path.join(__dirname, '..', 'schemas', 'v5', 'agent-identity.schema.json');
const fixtureDir = path.join(__dirname, 'fixtures', 'v5', 'agent-identity');

const requiredFixtureFields = [
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
  'verification_status',
  'expected_status',
  'expected_reason_code'
];

const expectedTrustTiers = [
  'unverified',
  'probationary',
  'trusted',
  'privileged',
  'root'
];

const expectedVerificationStatuses = [
  'unverified',
  'valid',
  'invalid',
  'revoked',
  'expired',
  'rejected'
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSchema() {
  return readJson(schemaPath);
}

function fixtureFiles() {
  return fs.readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

test('V5 agent identity schema parses and declares schema metadata', () => {
  const schema = readSchema();

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(typeof schema.$id, 'string');
  assert.equal(schema.type, 'object');
  assert.equal(Array.isArray(schema.required), true);
  assert.equal(typeof schema.properties, 'object');
});

test('V5 agent identity schema lists all required fixture fields', () => {
  const schema = readSchema();

  for (const field of requiredFixtureFields) {
    assert.equal(schema.required.includes(field), true, `${field} should be required`);
    assert.equal(Object.hasOwn(schema.properties, field), true, `${field} should have properties entry`);
  }
});

test('V5 agent identity schema declares trust tier contract values', () => {
  const schema = readSchema();
  const trustTierEnum = schema.properties.trust_tier.enum;

  for (const value of expectedTrustTiers) {
    assert.equal(trustTierEnum.includes(value), true, `missing trust_tier: ${value}`);
  }
});

test('V5 agent identity schema declares verification status contract values', () => {
  const schema = readSchema();
  const verificationStatusEnum = schema.properties.verification_status.enum;

  for (const value of expectedVerificationStatuses) {
    assert.equal(verificationStatusEnum.includes(value), true, `missing verification_status: ${value}`);
  }
});

test('V5 agent identity fixture files parse', () => {
  for (const fixtureName of fixtureFiles()) {
    const fixturePath = path.join(fixtureDir, fixtureName);

    assert.doesNotThrow(() => readJson(fixturePath), `${fixtureName} should parse`);
  }
});

test('V5 agent identity fixture keys are covered by schema properties', () => {
  const schema = readSchema();
  const schemaFields = new Set(Object.keys(schema.properties));

  for (const fixtureName of fixtureFiles()) {
    const fixture = readJson(path.join(fixtureDir, fixtureName));

    for (const key of Object.keys(fixture)) {
      assert.equal(schemaFields.has(key), true, `${fixtureName} key not covered by schema: ${key}`);
    }
  }
});

test('V5 agent identity schema test stays isolated from runtime modules', () => {
  const testSource = fs.readFileSync(__filename, 'utf8');
  const forbiddenRuntimeImport = /require\(['"]\.\.\/(?:kernel|server|mcpServer|lib\/|packages\/)/;

  assert.equal(forbiddenRuntimeImport.test(testSource), false);
});
