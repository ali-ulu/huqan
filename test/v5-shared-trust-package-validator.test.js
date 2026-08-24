const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateSharedTrustPackage,
  validateSharedTrustPackageFile,
  SHARED_TRUST_PACKAGE_SCHEMA_VERSION
} = require('../schemas/v5/shared-trust-package-validator');

const fixtureDir = path.join(__dirname, 'fixtures', 'v5', 'shared-trust-package');
const validatorPath = path.join(__dirname, '..', 'schemas', 'v5', 'shared-trust-package-validator.js');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertStructuredResult(result) {
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.valid, 'boolean');
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

function assertValidFixture(name) {
  const fixture = readFixture(name);
  const before = JSON.stringify(fixture);
  const result = validateSharedTrustPackage(fixture);

  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(JSON.stringify(fixture), before, `${name} should not be mutated`);
}

function assertInvalidFixture(name, expectedCode, expectedPath) {
  const result = validateSharedTrustPackage(readFixture(name));

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(result.errors.some((error) => error.code === expectedCode && error.path === expectedPath), true);
}

test('V5 shared trust package validator accepts the valid fixtures', () => {
  for (const name of [
    'valid-minimal.json',
    'valid-with-route-receipt.json',
    'valid-reasoning-metadata.json',
    'valid-route-receipt-chain.json'
  ]) {
    assertValidFixture(name);
  }
});

test('V5 shared trust package validator reads valid fixtures from file paths', () => {
  const result = validateSharedTrustPackageFile(path.join(fixtureDir, 'valid-minimal.json'));

  assert.deepEqual(result, { valid: true, errors: [] });
});

test('V5 shared trust package validator exposes the expected schema version constant', () => {
  assert.equal(SHARED_TRUST_PACKAGE_SCHEMA_VERSION, 'v5-shared-trust-package/v0.1');
});

test('V5 shared trust package validator rejects missing package identity', () => {
  assertInvalidFixture('invalid-missing-package-id.json', 'missing_required_field', 'packageId');
});

test('V5 shared trust package validator rejects missing verdict status', () => {
  assertInvalidFixture('invalid-missing-verdict.json', 'missing_required_field', 'verdict.status');
});

test('V5 shared trust package validator rejects runtime implementation claims', () => {
  const result = validateSharedTrustPackage(readFixture('invalid-runtime-claim.json'));

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(result.errors.some((error) => error.code === 'unknown_field' && error.path === '/writerImplemented'), true);
});

test('V5 shared trust package validator rejects reasoning runtime claims', () => {
  const result = validateSharedTrustPackage(readFixture('invalid-reasoning-metadata-runtime-claim.json'));

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(
    result.errors.some((error) => error.code === 'unknown_field' && error.path === 'reasoningMetadata.reasoningEngineImplemented'),
    true
  );
});

test('V5 shared trust package validator rejects missing route receipt metadata', () => {
  const fixture = clone(readFixture('valid-with-route-receipt.json'));
  delete fixture.receipt.routeReceipt.metadata;

  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(
    result.errors.some((error) => error.code === 'missing_required_field' && error.path === 'receipt.routeReceipt.metadata'),
    true
  );
});

test('V5 shared trust package schema.json required list agrees with the validator on receipt.routeReceipt.metadata (#1311)', () => {
  // The validator hand-codes this rule (schema.json's required arrays are
  // only consulted for the root object, not nested ones -- see
  // shared-trust-package-validator.js), so nothing enforces schema/validator
  // agreement automatically. Assert it explicitly so the two cannot drift
  // apart again the way they did before #1311: the validator rejected a
  // schema-conformant package (routeReceipt without metadata) because the
  // schema listed metadata as optional while the validator required it.
  const schema = require('../schemas/v5/shared-trust-package.schema.json');
  const routeReceiptSchema = schema.properties.receipt.properties.routeReceipt;
  assert.deepEqual([...routeReceiptSchema.required].sort(), ['hopCount', 'metadata', 'routeId']);
});

test('V5 shared trust package validator rejects malformed route receipt metadata', () => {
  const fixture = clone(readFixture('valid-with-route-receipt.json'));
  fixture.receipt.routeReceipt.metadata.transport = { nested: true };

  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(
    result.errors.some((error) => error.code === 'invalid_metadata_value' && error.path === 'receipt.routeReceipt.metadata.transport'),
    true
  );
});

test('V5 shared trust package validator rejects missing reasoning metadata for reasoning packages', () => {
  const fixture = clone(readFixture('valid-reasoning-metadata.json'));
  delete fixture.reasoningMetadata;

  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(
    result.errors.some((error) => error.code === 'missing_required_field' && error.path === 'reasoningMetadata'),
    true
  );
});

test('V5 shared trust package validator rejects malformed reasoning metadata', () => {
  const fixture = clone(readFixture('valid-reasoning-metadata.json'));
  fixture.reasoningMetadata.steps[0].status = 'unsupported';

  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(
    result.errors.some((error) => error.code === 'invalid_enum_value' && error.path === 'reasoningMetadata.steps[0].status'),
    true
  );
});

test('V5 shared trust package validator rejects route receipt chains with missing hop identity', () => {
  const result = validateSharedTrustPackage(readFixture('invalid-route-hop-missing-agent-id.json'));

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(
    result.errors.some((error) => error.code === 'missing_required_field' && error.path === 'routeReceipt.hops[0].agentId'),
    true
  );
});

test('V5 shared trust package validator rejects unsupported schema versions', () => {
  const fixture = clone(readFixture('valid-minimal.json'));
  fixture.schemaVersion = 'v5-shared-trust-package/v9.9';

  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(
    result.errors.some((error) => error.code === 'invalid_schema_version' && error.path === 'schemaVersion'),
    true
  );
});

test('V5 shared trust package validator is deterministic and does not mutate inputs', () => {
  const fixture = readFixture('valid-route-receipt-chain.json');
  const before = JSON.stringify(fixture);

  const first = validateSharedTrustPackage(fixture);
  const second = validateSharedTrustPackage(fixture);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(fixture), before);
});

test('V5 shared trust package validator stays isolated from runtime and signing dependencies', () => {
  const source = fs.readFileSync(validatorPath, 'utf8');
  const forbiddenImportPattern = /require\(['"](?:\.\.\/)?(?:kernel|server|mcpServer|lib\/|packages\/|public\/)/;
  const forbiddenRuntimeWords = /\b(signing runtime|verification runtime|A2A|connector enforcement|marketplace)\b/i;

  assert.equal(forbiddenImportPattern.test(source), false);
  assert.equal(forbiddenRuntimeWords.test(source), false);
});


test('V5 shared trust package validator rejects unknown subject types and validates supplied routeReceipt independently', () => {
  const fixture = clone(readFixture('valid-minimal.json'));
  fixture.subject.type = 'other';
  fixture.routeReceipt = {
    hops: 'not-an-array',
    arbitrary: { nested: true },
  };

  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.valid, false);
  assertStructuredResult(result);
  assert.equal(
    result.errors.some((error) => error.code === 'invalid_enum_value' && error.path === 'subject.type'),
    true
  );
  assert.equal(
    result.errors.some((error) => error.code === 'unknown_field' && error.path === 'routeReceipt.arbitrary'),
    true
  );
  assert.equal(
    result.errors.some((error) => error.code === 'missing_required_field' && error.path === 'routeReceipt.hops'),
    true
  );
});

test('V5 shared trust package validator keeps route_receipt receipt route required', () => {
  const fixture = clone(readFixture('valid-minimal.json'));
  fixture.subject.type = 'route_receipt';

  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some((error) => error.code === 'missing_required_field' && error.path === 'receipt.routeReceipt'),
    true
  );
});
