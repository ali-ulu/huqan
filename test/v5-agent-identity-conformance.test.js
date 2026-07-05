const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  runAgentIdentityConformance,
  summarizeAgentIdentityConformance
} = require('../schemas/v5/agent-identity-conformance');

const schemaPath = path.join(__dirname, '..', 'schemas', 'v5', 'agent-identity.schema.json');
const fixturesDir = path.join(__dirname, 'fixtures', 'v5', 'agent-identity');

function runConformance() {
  return runAgentIdentityConformance({
    schemaPath,
    fixturesDir
  });
}

function assertStructuredErrors(errors) {
  assert.equal(Array.isArray(errors), true);

  for (const error of errors) {
    assert.equal(typeof error.code, 'string');
    assert.notEqual(error.code.trim(), '');
    assert.equal(typeof error.path, 'string');
    assert.notEqual(error.path.trim(), '');
    assert.equal(typeof error.message, 'string');
    assert.notEqual(error.message.trim(), '');
  }
}

test('V5 agent identity conformance links fixtures, schema, and validator', () => {
  const result = runConformance();

  assert.equal(result.ok, true);
  assert.equal(result.schemaPath, schemaPath);
  assert.equal(result.fixturesDir, fixturesDir);
  assert.equal(result.totalFixtures, 6);
  assert.equal(result.passed, 6);
  assert.equal(result.failed, 0);
  assert.equal(Array.isArray(result.results), true);
  assert.equal(result.results.length, 6);

  for (const item of result.results) {
    assert.equal(typeof item.file, 'string');
    assert.notEqual(item.file.trim(), '');
    assert.equal(typeof item.expected_status, 'string');
    assert.equal(typeof item.validator_valid, 'boolean');
    assert.equal(typeof item.conformance_valid, 'boolean');
    assert.equal(Array.isArray(item.errors), true);
  }
});

test('V5 agent identity conformance accepts valid fixture and preserves invalid expectations', () => {
  const result = runConformance();
  const byFile = new Map(result.results.map((item) => [item.file, item]));
  const valid = byFile.get('valid.minimal.json');

  assert.equal(valid.validator_valid, true);
  assert.equal(valid.conformance_valid, true);
  assert.deepEqual(valid.errors, []);

  for (const item of result.results.filter((entry) => entry.file.startsWith('invalid.'))) {
    assert.equal(item.validator_valid, false, `${item.file} should remain validator-invalid`);
    assert.equal(item.conformance_valid, true, `${item.file} should be conformance-valid`);
    assert.equal(typeof item.expected_reason_code, 'string');
    assertStructuredErrors(item.errors);
    assert.equal(
      item.errors.some((error) => error.code === item.expected_reason_code),
      true,
      `${item.file} should preserve ${item.expected_reason_code}`
    );
  }
});

test('V5 agent identity conformance summary reports all fixtures passing conformance', () => {
  const result = runConformance();
  const summary = summarizeAgentIdentityConformance(result.results);

  assert.deepEqual(summary, {
    ok: true,
    totalFixtures: 6,
    passed: 6,
    failed: 0,
    failingFiles: []
  });
});
