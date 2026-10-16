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


test('V5 agent identity validator rejects invalid schema', () => {
  const fixture = { expected_status: 'valid', expected_reason_code: null };
  const result = validateAgentIdentityFixture(fixture, null);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'invalid_schema_object');
});

test('V5 agent identity validator missing expected status', () => {
  const schema = readSchema();
  const fixture = { expected_reason_code: null };
  const result = validateAgentIdentityFixture(fixture, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'missing_expected_status'));
});

test('V5 agent identity validator missing expected reason code', () => {
  const schema = readSchema();
  const fixture = { expected_status: 'valid' };
  const result = validateAgentIdentityFixture(fixture, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'missing_expected_reason_code'));
});

test('V5 agent identity validator identity claim shape', () => {
  const schema = readSchema();
  const fixture = {
    expected_status: 'invalid',
    expected_reason_code: 'identity.invalid_claim',
    agent_id: 'a1',
    verification_status: 'valid'
  };
  const result = validateAgentIdentityFixture(fixture, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'identity_claim_present'));
  assert.ok(result.errors.some(e => e.code === 'invalid_claim_status_required'));
});

test('V5 agent identity validator delegation scope exceeded', () => {
  const schema = readSchema();
  const fixture = {
    expected_status: 'invalid',
    expected_reason_code: 'delegation.scope_exceeded',
    delegation_scope: ['read'],
    trust_tier: 'verified'
  };
  const result = validateAgentIdentityFixture(fixture, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'scope_exceeded_invoke_required'));
  
  fixture.delegation_scope = ['invoke'];
  const result2 = validateAgentIdentityFixture(fixture, schema);
  assert.ok(result2.errors.some(e => e.code === 'scope_exceeded_trust_floor'));
});

test('V5 agent identity validator delegation chain invalid', () => {
  const schema = readSchema();
  const fixture = {
    expected_status: 'invalid',
    expected_reason_code: 'delegation.chain_invalid'
  };
  const result = validateAgentIdentityFixture(fixture, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'chain_invalid_parent_required'));
  
  fixture.parent_agent_id = 'p1';
  const result2 = validateAgentIdentityFixture(fixture, schema);
  assert.ok(result2.errors.some(e => e.code === 'chain_invalid_chain_required'));
  
  fixture.delegation_chain = ['p1'];
  const result3 = validateAgentIdentityFixture(fixture, schema);
  assert.ok(result3.errors.some(e => e.code === 'chain_invalid_parent_encoded'));
});

test('V5 agent identity validator connector context', () => {
  const schema = readSchema();
  const fixture = {
    expected_status: 'invalid',
    expected_reason_code: 'connector.context_invalid',
    allowed_connectors: ['c1']
  };
  const result = validateAgentIdentityFixture(fixture, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'connector_context_no_connectors'));
});

test('V5 agent identity validator lifecycle unresolvable', () => {
  const schema = readSchema();
  const fixture = {
    expected_status: 'invalid',
    expected_reason_code: 'lifecycle.unresolved',
    verification_status: 'valid',
    revoked_at: 'now'
  };
  const result = validateAgentIdentityFixture(fixture, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'lifecycle_unresolved_status_required'));
  
  fixture.verification_status = 'unverified';
  const result2 = validateAgentIdentityFixture(fixture, schema);
  assert.ok(result2.errors.some(e => e.code === 'lifecycle_unresolved_no_resolved_events'));
});

test('validateAgentIdentityFixtureFile handles missing files', () => {
  const result = validateAgentIdentityFixtureFile('does-not-exist.json', 'also-missing.json');
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'fixture_read_error');
});

// #1537: all ten shape validators were gated on expected_reason_code, and that
// field had no enum anywhere. A one-character typo in the discriminator turned
// every shape rule off at once, and because validateExpectedInvalidState echoes
// the declared code into errors, the output was indistinguishable from a
// correctly-written fixture's.
test('a misspelled expected_reason_code is rejected, not silently obeyed', () => {
  const schema = readSchema();
  const fixture = readFixture('invalid.workspace_mismatch.json');

  // Break the rule the fixture exists to encode: the requested workspace now
  // matches, so there is no mismatch to detect.
  fixture.requested_workspace_id = fixture.workspace_id;
  const caught = validateAgentIdentityFixture(fixture, schema).errors.map((error) => error.code);
  assert.ok(caught.includes('workspace_mismatch_not_encoded'), 'the shape rule must catch this');

  // One character, and previously every shape rule stopped running.
  fixture.expected_reason_code += '_';
  const codes = validateAgentIdentityFixture(fixture, schema).errors.map((error) => error.code);
  assert.ok(codes.includes('enum_value_not_allowed'), 'the discriminator itself is now enum-checked');
  assert.ok(codes.includes('unknown_reason_code'), 'a code with no shape rules is named, not ignored');
});

test('every shape-validated reason code is reachable through the dispatch table', () => {
  const schema = readSchema();

  // Each of these fixtures must still produce its own declared code, which is
  // only true if the table routes it to the right validator.
  const cases = [
    ['invalid.revoked_identity.json', 'identity_revoked'],
    ['invalid.expired_identity.json', 'identity_expired'],
    ['invalid.workspace_mismatch.json', 'workspace_mismatch'],
    ['invalid.identity_claim.json', 'identity.invalid_claim'],
    ['invalid.delegation_scope_exceeded.json', 'delegation.scope_exceeded'],
    ['invalid.delegation_chain.json', 'delegation.chain_invalid'],
    ['invalid.connector_context.json', 'connector.context_invalid'],
    ['invalid.unresolvable_lifecycle.json', 'lifecycle.unresolved'],
    ['invalid.broken_delegation_chain.json', 'broken_delegation_chain'],
    ['invalid.missing_agent_id.json', 'missing_agent_id'],
  ];

  for (const [name, expectedCode] of cases) {
    const codes = validateAgentIdentityFixture(readFixture(name), schema).errors.map((error) => error.code);
    assert.ok(codes.includes(expectedCode), `${name} must still declare ${expectedCode}`);
    assert.ok(!codes.includes('unknown_reason_code'), `${name} must be a known code`);
    assert.ok(!codes.includes('enum_value_not_allowed'), `${name} must satisfy the schema enums`);
  }
});

test('a valid-class fixture declares no reason code and is not treated as unknown', () => {
  const schema = readSchema();
  for (const name of ['valid.minimal.json', 'valid.linkage_recomputation.json']) {
    const result = validateAgentIdentityFixture(readFixture(name), schema);
    assert.equal(result.valid, true, `${name} must stay valid`);
    assert.deepEqual(result.errors, []);
  }
});

test('an unrecognized expected_status is rejected too', () => {
  const schema = readSchema();
  const fixture = readFixture('invalid.revoked_identity.json');
  fixture.expected_status = 'revoked_';

  const codes = validateAgentIdentityFixture(fixture, schema).errors.map((error) => error.code);
  assert.ok(codes.includes('enum_value_not_allowed'), 'expected_status gates validateExpectedInvalidState');
});
