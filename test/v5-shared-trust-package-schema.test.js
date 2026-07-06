const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schemaPath = path.join(__dirname, '..', 'schemas', 'v5', 'shared-trust-package.schema.json');
const fixtureDir = path.join(__dirname, 'fixtures', 'v5', 'shared-trust-package');

const requiredTopLevelFields = [
  'schemaVersion',
  'packageId',
  'issuer',
  'subject',
  'verdict',
  'receipt',
  'evidence',
  'nonClaims'
];

const forbiddenRuntimeClaims = [
  'writerImplemented',
  'readerImplemented',
  'runtimeEnforced',
  'a2aTransportEnabled',
  'marketplaceReady',
  'agentActionPolicyEngineEnabled'
];

const expectedVerdicts = [
  'allow',
  'review',
  'dry_run_only',
  'block'
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSchema() {
  return readJson(schemaPath);
}

function readFixture(name) {
  return readJson(path.join(fixtureDir, name));
}

function validateSharedTrustPackage(fixture) {
  const schema = readSchema();
  const errors = [];

  for (const field of schema.required) {
    if (!Object.hasOwn(fixture, field)) {
      errors.push({ code: 'required', path: field });
    }
  }

  for (const key of Object.keys(fixture)) {
    if (!Object.hasOwn(schema.properties, key)) {
      errors.push({ code: 'additional_property', path: key });
    }
  }

  if (fixture.schemaVersion !== 'v5-shared-trust-package/v0.1') {
    errors.push({ code: 'const', path: 'schemaVersion' });
  }

  if (!fixture.issuer || typeof fixture.issuer.agentId !== 'string' || fixture.issuer.agentId === '') {
    errors.push({ code: 'required', path: 'issuer.agentId' });
  }

  if (!fixture.issuer || typeof fixture.issuer.workspaceId !== 'string' || fixture.issuer.workspaceId === '') {
    errors.push({ code: 'required', path: 'issuer.workspaceId' });
  }

  if (!fixture.subject || typeof fixture.subject.type !== 'string' || fixture.subject.type === '') {
    errors.push({ code: 'required', path: 'subject.type' });
  }

  if (!fixture.subject || typeof fixture.subject.id !== 'string' || fixture.subject.id === '') {
    errors.push({ code: 'required', path: 'subject.id' });
  }

  if (!fixture.verdict || typeof fixture.verdict.status !== 'string') {
    errors.push({ code: 'required', path: 'verdict.status' });
  } else if (!expectedVerdicts.includes(fixture.verdict.status)) {
    errors.push({ code: 'enum', path: 'verdict.status' });
  }

  if (!fixture.receipt || typeof fixture.receipt.receiptId !== 'string' || fixture.receipt.receiptId === '') {
    errors.push({ code: 'required', path: 'receipt.receiptId' });
  }

  if (!fixture.receipt || typeof fixture.receipt.issuedAt !== 'string' || fixture.receipt.issuedAt === '') {
    errors.push({ code: 'required', path: 'receipt.issuedAt' });
  }

  if (!Array.isArray(fixture.evidence)) {
    errors.push({ code: 'type', path: 'evidence' });
  }

  if (!Array.isArray(fixture.nonClaims) || fixture.nonClaims.length === 0) {
    errors.push({ code: 'required', path: 'nonClaims' });
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

test('V5 shared trust package schema parses and declares schema metadata', () => {
  const schema = readSchema();

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, 'https://huqan.local/schemas/v5/shared-trust-package.schema.json');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
});

test('V5 shared trust package schema requires minimum package fields', () => {
  const schema = readSchema();

  for (const field of requiredTopLevelFields) {
    assert.equal(schema.required.includes(field), true, `${field} should be required`);
    assert.equal(Object.hasOwn(schema.properties, field), true, `${field} should have a schema property`);
  }

  assert.deepEqual(schema.properties.issuer.required, ['agentId', 'workspaceId']);
  assert.deepEqual(schema.properties.subject.required, ['type', 'id']);
  assert.deepEqual(schema.properties.verdict.required, ['status']);
  assert.deepEqual(schema.properties.receipt.required, ['receiptId', 'issuedAt']);
});

test('V5 shared trust package schema preserves canonical verdict vocabulary', () => {
  const schema = readSchema();

  assert.deepEqual(schema.properties.verdict.properties.status.enum, expectedVerdicts);
});

test('V5 shared trust package valid minimal fixture passes', () => {
  const fixture = readFixture('valid-minimal.json');
  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('V5 shared trust package route receipt fixture passes', () => {
  const fixture = readFixture('valid-with-route-receipt.json');
  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.ok, true);
  assert.equal(fixture.receipt.routeReceipt.routeId, 'route.example.001');
});

test('V5 shared trust package missing packageId fixture fails', () => {
  const fixture = readFixture('invalid-missing-package-id.json');
  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.path === 'packageId'), true);
});

test('V5 shared trust package missing verdict.status fixture fails', () => {
  const fixture = readFixture('invalid-missing-verdict.json');
  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.path === 'verdict.status'), true);
});

test('V5 shared trust package runtime implementation claim fixture fails', () => {
  const fixture = readFixture('invalid-runtime-claim.json');
  const result = validateSharedTrustPackage(fixture);

  assert.equal(result.ok, false);

  for (const claim of forbiddenRuntimeClaims) {
    assert.equal(
      result.errors.some((error) => error.code === 'additional_property' && error.path === claim),
      true,
      `${claim} should be forbidden`
    );
  }
});

test('V5 shared trust package schema preserves non-implementation boundary', () => {
  const schema = readSchema();
  const description = `${schema.description} ${schema.$comment}`;

  assert.match(description, /does not implement runtime writer support/);
  assert.match(description, /Runtime Trust Package writer\/reader/);
  assert.equal(schema.properties.nonClaims.minItems, 1);
});

test('V5 shared trust package schema test stays isolated from runtime modules', () => {
  const testSource = fs.readFileSync(__filename, 'utf8');
  const forbiddenRuntimeImport = /require\(['"]\.\.\/(?:kernel|server|mcpServer|lib\/|packages\/)/;

  assert.equal(forbiddenRuntimeImport.test(testSource), false);
});
