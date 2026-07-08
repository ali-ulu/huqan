const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { writeRuntimePackage } = require('../lib/v5/runtime-writer');

const fixtureRoot = path.join(__dirname, '..', 'fixtures', 'v5', 'runtime-writer');

const validFixtures = [
  'valid/minimal-writer-input.json',
  'valid/route-receipt-metadata.json',
  'valid/reasoning-metadata.json',
  'valid/provenance-metadata.json'
];

const invalidFixtures = [
  'invalid/missing-agent-identity.json',
  'invalid/missing-workspace-identity.json',
  'invalid/missing-trust-package-identity.json',
  'invalid/malformed-route-receipt-metadata.json',
  'invalid/malformed-reasoning-metadata.json',
  'invalid/unsigned-but-claimed-signed.json',
  'invalid/runtime-reader-claim.json',
  'invalid/connector-enforcement-claim.json',
  'invalid/marketplace-claim.json',
  'invalid/agentaction-policy-engine-claim.json'
];

const allFixtures = [...validFixtures, ...invalidFixtures];

const forbiddenContentPattern = /secret|token|credential|password|https?:\/\/|Date\.now|Math\.random|new Date|C:\\|\/Users\/|\/home\//i;

function listFixtureFiles() {
  return fs
    .readdirSync(fixtureRoot, { recursive: true })
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.replace(/\\/g, '/'))
    .sort();
}

function readFixture(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8'));
}

function readFixtureText(relativePath) {
  return fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8');
}

function assertWriterInputShape(fixture, relativePath) {
  assert.equal(typeof fixture.caseId, 'string', `${relativePath} should define caseId`);
  assert.equal(typeof fixture.description, 'string', `${relativePath} should define description`);
  assert.equal(typeof fixture.writerInput, 'object', `${relativePath} should define writerInput`);
  assert.equal(typeof fixture.expected, 'object', `${relativePath} should define expected`);
  assert.equal(fixture.writerInput.schemaVersion, 'v5.shared_trust_package.writer_input.v1');
}

function assertWriterResultMatchesFixture(fixture, relativePath) {
  const firstResult = writeRuntimePackage(fixture.writerInput);
  const secondResult = writeRuntimePackage(fixture.writerInput);

  assert.deepEqual(secondResult, firstResult, `${relativePath} writer output should be deterministic`);
  assert.equal(firstResult.verdict, fixture.expected.verdict, `${relativePath} writer verdict should match fixture`);
  assert.equal(firstResult.reason_category, fixture.expected.reason_category, `${relativePath} reason category should match fixture`);

  if (fixture.expected.verdict === 'ACCEPT') {
    assert.equal(firstResult.ok, true, `${relativePath} accepted writer output should be ok`);
    assert.equal(typeof firstResult.package, 'object', `${relativePath} accepted writer output should include package`);
    assert.equal(firstResult.package.packageId, fixture.writerInput.packageId, `${relativePath} packageId should be preserved`);
    assert.deepEqual(firstResult.package.issuer, fixture.writerInput.issuer, `${relativePath} issuer should be preserved`);
    assert.deepEqual(firstResult.package.subject, fixture.writerInput.subject, `${relativePath} subject should be preserved`);
    assert.deepEqual(firstResult.package.verdict, fixture.writerInput.verdict, `${relativePath} verdict metadata should be preserved`);
    return;
  }

  assert.equal(firstResult.ok, false, `${relativePath} blocked writer output should not be ok`);
  assert.equal(Object.hasOwn(firstResult, 'package'), false, `${relativePath} blocked writer output must not emit package`);
}

test('V5 runtime writer fixtures expose exactly the expected 14 JSON files', () => {
  assert.deepEqual(listFixtureFiles(), [...allFixtures].sort());
});

test('V5 runtime writer valid fixtures stay deterministic and accepted', () => {
  for (const relativePath of validFixtures) {
    const fixture = readFixture(relativePath);
    const text = readFixtureText(relativePath);

    assertWriterInputShape(fixture, relativePath);
    assert.equal(fixture.expected.verdict, 'ACCEPT', `${relativePath} should remain ACCEPT`);
    assert.equal(typeof fixture.expected.reason_category, 'string');
    assert.notEqual(fixture.expected.reason_category.trim(), '');
    assert.equal(forbiddenContentPattern.test(text), false, `${relativePath} should not include forbidden content`);
    assert.equal(JSON.stringify(fixture).includes('runtimeWriterImplemented'), false, `${relativePath} must not claim runtime writer implementation`);
    assert.equal(JSON.stringify(fixture).includes('runtimeReaderImplemented'), false, `${relativePath} must not claim runtime reader implementation`);
    assertWriterResultMatchesFixture(fixture, relativePath);
  }
});

test('V5 runtime writer invalid fixtures stay fail-closed and deterministic', () => {
  for (const relativePath of invalidFixtures) {
    const fixture = readFixture(relativePath);
    const text = readFixtureText(relativePath);

    assertWriterInputShape(fixture, relativePath);
    assert.equal(fixture.expected.verdict, 'BLOCK', `${relativePath} should remain BLOCK`);
    assert.equal(typeof fixture.expected.reason_category, 'string');
    assert.notEqual(fixture.expected.reason_category.trim(), '');
    assert.equal(forbiddenContentPattern.test(text), false, `${relativePath} should not include forbidden content`);
    assertWriterResultMatchesFixture(fixture, relativePath);
  }
});

test('V5 runtime writer fixtures preserve claim-discipline boundaries', () => {
  const readerClaimFixture = readFixture('invalid/runtime-reader-claim.json');
  const connectorClaimFixture = readFixture('invalid/connector-enforcement-claim.json');
  const marketplaceClaimFixture = readFixture('invalid/marketplace-claim.json');
  const agentActionClaimFixture = readFixture('invalid/agentaction-policy-engine-claim.json');
  const signedClaimFixture = readFixture('invalid/unsigned-but-claimed-signed.json');

  assert.equal(readerClaimFixture.writerInput.claims.runtimeReaderImplemented, true);
  assert.equal(connectorClaimFixture.writerInput.claims.connectorEnforcement, true);
  assert.equal(marketplaceClaimFixture.writerInput.claims.marketplaceReady, true);
  assert.equal(agentActionClaimFixture.writerInput.claims.agentActionPolicyEngine, true);
  assert.equal(signedClaimFixture.writerInput.claims.signed, true);
  assert.equal(signedClaimFixture.writerInput.claims.signatureRuntime, 'not_implemented');

  for (const fixture of [readerClaimFixture, connectorClaimFixture, marketplaceClaimFixture, agentActionClaimFixture, signedClaimFixture]) {
    assert.equal(fixture.expected.verdict, 'BLOCK');
    assert.equal(typeof fixture.expected.reason_category, 'string');
  }
});
