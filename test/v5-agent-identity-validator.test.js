const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateAgentIdentityFixture,
  validateAgentIdentityFixtureFile
} = require('../schemas/v5/agent-identity-validator');

const schemaPath = path.join(__dirname, '..', 'schemas', 'v5', 'agent-identity.schema.json');
const fixtureDir = path.join(__dirname, 'fixtures', 'v5', 'agent-identity');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSchema() {
  return readJson(schemaPath);
}

function fixturePath(name) {
  return path.join(fixtureDir, name);
}

function readFixture(name) {
  return readJson(fixturePath(name));
}

function assertStructuredErrors(result) {
  assert.equal(Array.isArray(result.errors), true);

  for (const error of result.errors) {
    assert.equal(typeof error.code, 'string');
    assert.notEqual(error.code.trim(), '');
    assert.equal(typeof error.path, 'string');
    assert.notEqual(error.path.trim(), '');
    assert.equal(typeof error.message, 'string');
    assert.notEqual(error.message.trim(), '');
  }
}

function assertInvalidFixture(name, expectedCode) {
  const result = validateAgentIdentityFixtureFile(fixturePath(name), schemaPath);

  assert.equal(result.valid, false);
  assertStructuredErrors(result);
  assert.equal(result.errors.some((error) => error.code === expectedCode), true);
}

test('V5 agent identity validator accepts the valid minimal fixture', () => {
  const result = validateAgentIdentityFixtureFile(fixturePath('valid.minimal.json'), schemaPath);

  assert.deepEqual(result, {
    valid: true,
    errors: []
  });
});

test('V5 agent identity validator rejects missing agent identity', () => {
  const result = validateAgentIdentityFixtureFile(fixturePath('invalid.missing_agent_id.json'), schemaPath);

  assert.equal(result.valid, false);
  assertStructuredErrors(result);
  assert.equal(result.errors.some((error) => error.code === 'missing_required_field' && error.path === '/agent_id'), true);
  assert.equal(result.errors.some((error) => error.code === 'missing_agent_id'), true);
});

test('V5 agent identity validator preserves revoked fixture reason', () => {
  assertInvalidFixture('invalid.revoked_identity.json', 'identity_revoked');
});

test('V5 agent identity validator preserves expired fixture reason', () => {
  assertInvalidFixture('invalid.expired_identity.json', 'identity_expired');
});

test('V5 agent identity validator preserves workspace mismatch reason', () => {
  assertInvalidFixture('invalid.workspace_mismatch.json', 'workspace_mismatch');
});

test('V5 agent identity validator preserves broken delegation reason', () => {
  assertInvalidFixture('invalid.broken_delegation_chain.json', 'broken_delegation_chain');
});

test('V5 agent identity validator reports unknown fixture fields from schema properties', () => {
  const schema = readSchema();
  const fixture = {
    ...readFixture('valid.minimal.json'),
    unexpected_field: 'not-covered'
  };
  const result = validateAgentIdentityFixture(fixture, schema);

  assert.equal(result.valid, false);
  assertStructuredErrors(result);
  assert.equal(result.errors.some((error) => error.code === 'unknown_field' && error.path === '/unexpected_field'), true);
});

test('V5 agent identity validator reports enum contract failures', () => {
  const schema = readSchema();
  const fixture = {
    ...readFixture('valid.minimal.json'),
    trust_tier: 'superuser',
    verification_status: 'maybe'
  };
  const result = validateAgentIdentityFixture(fixture, schema);

  assert.equal(result.valid, false);
  assertStructuredErrors(result);
  assert.equal(result.errors.some((error) => error.code === 'enum_value_not_allowed' && error.path === '/trust_tier'), true);
  assert.equal(result.errors.some((error) => error.code === 'enum_value_not_allowed' && error.path === '/verification_status'), true);
});

test('V5 agent identity validator test stays isolated from runtime modules', () => {
  const testSource = fs.readFileSync(__filename, 'utf8');
  const validatorSource = fs.readFileSync(
    path.join(__dirname, '..', 'schemas', 'v5', 'agent-identity-validator.js'),
    'utf8'
  );
  const forbiddenRuntimeImport = /require\(['"](?:\.\.\/)?(?:kernel|server|mcpServer|lib\/|packages\/)/;

  assert.equal(forbiddenRuntimeImport.test(testSource), false);
  assert.equal(forbiddenRuntimeImport.test(validatorSource), false);
});
