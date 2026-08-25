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

// Ratchet bump 8 -> 13 (validator extension for Gate 7's remaining classes, #846):
// +invalid.identity_claim.json — malformed claim assertion
// +invalid.delegation_scope_exceeded.json — over-bounded scope assertion
// +invalid.delegation_chain.json — unresolvable chain assertion
// +invalid.connector_context.json — absent connector context assertion
// +invalid.unresolvable_lifecycle.json — reject-whole lifecycle assertion
test('V5 agent identity conformance links fixtures, schema, and validator', () => {
  const result = runConformance();

  assert.equal(result.ok, true);
  assert.equal(result.schemaPath, schemaPath);
  assert.equal(result.fixturesDir, fixturesDir);
  assert.equal(result.totalFixtures, 13);
  assert.equal(result.passed, 13);
  assert.equal(result.failed, 0);
  assert.equal(Array.isArray(result.results), true);
  assert.equal(result.results.length, 13);

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
    totalFixtures: 13,
    passed: 13,
    failed: 0,
    failingFiles: []
  });
});

// #1537: the conformance check asked "do the errors contain the declared reason
// code?" -- and validateExpectedInvalidState echoes that declared code into
// errors. So a misspelled discriminator matched itself while every shape rule
// keyed on that code had been skipped: the check proved the fixture *names* a
// violation, not that it *encodes* one.
test('a fixture whose declared reason code is unusable does not conform', () => {
  const fs = require('node:fs');
  const os = require('node:os');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-agent-identity-conformance-'));
  try {
    for (const file of fs.readdirSync(fixturesDir)) {
      fs.copyFileSync(path.join(fixturesDir, file), path.join(tempDir, file));
    }

    const clean = runAgentIdentityConformance({ schemaPath, fixturesDir: tempDir });
    assert.equal(clean.ok, true, 'the untouched copy must still conform');

    const target = path.join(tempDir, 'invalid.workspace_mismatch.json');
    const fixture = JSON.parse(fs.readFileSync(target, 'utf8'));
    // Break the encoded violation, then misspell the discriminator by one
    // character -- the combination that used to pass.
    fixture.requested_workspace_id = fixture.workspace_id;
    fixture.expected_reason_code += '_';
    fs.writeFileSync(target, JSON.stringify(fixture));

    const result = runAgentIdentityConformance({ schemaPath, fixturesDir: tempDir });
    assert.equal(result.ok, false, 'a typo in the discriminator must fail conformance');
    assert.equal(result.failed, 1);

    const failing = result.results.find((entry) => entry.file === 'invalid.workspace_mismatch.json');
    assert.equal(failing.conformance_valid, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
