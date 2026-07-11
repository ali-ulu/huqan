'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'trusted-key-resolver');
const verificationFixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'verification');
const expectedFixtureFiles = [
  '01-active-key-reference.json',
  '02-unknown-key-reference.json',
  '03-revoked-key-reference.json',
  '04-expired-key-metadata-boundary.json',
  '05-lookup-unavailable.json',
  '06-malformed-key-reference.json',
  '07-unknown-top-level-metadata.json',
  '08-nested-secret-private-key-material.json',
  '09-nested-network-provider-metadata.json',
  '10-unsafe-key-material-alias.json',
  '11-ambiguous-duplicate-record.json',
  '12-deterministic-repeat.json'
];
const allowedStates = new Set([
  'active',
  'unknown',
  'revoked',
  'expired',
  'unavailable',
  'malformed'
]);
const allowedNonClaims = new Set([
  'package_trust_not_established',
  'action_authorization_not_established',
  'identity_verification_not_established',
  'external_exchange_not_established',
  'production_crypto_not_claimed'
]);
const fixedEvaluationTime = '2026-02-01T12:00:00.000Z';
const expectedOutcomes = new Map([
  ['resolver-active-key-reference', ['active', undefined]],
  ['resolver-unknown-key-reference', ['unknown', 'unknown_key']],
  ['resolver-revoked-key-reference', ['revoked', 'revoked_key']],
  ['resolver-expired-key-metadata-boundary', ['expired', 'expired_key_metadata']],
  ['resolver-lookup-unavailable', ['unavailable', 'key_lookup_unavailable']],
  ['resolver-malformed-key-reference', ['malformed', 'malformed_trusted_key_record']],
  ['resolver-unknown-top-level-metadata', ['malformed', 'malformed_trusted_key_record']],
  ['resolver-nested-secret-private-key-material', ['malformed', 'malformed_trusted_key_record']],
  ['resolver-nested-network-provider-metadata', ['malformed', 'malformed_trusted_key_record']],
  ['resolver-unsafe-key-material-alias', ['malformed', 'malformed_trusted_key_record']],
  ['resolver-ambiguous-duplicate-record', ['malformed', 'malformed_trusted_key_record']],
  ['resolver-deterministic-repeat', ['active', undefined]]
]);
const forbiddenMaterialKeys = /^(privateKey|private_key|secret|credential|token|password|networkEndpoint|network_endpoint|url|uri|endpoint|certificate|pem|jwk|keyMaterial|key_material)$/i;

function fixtureFiles() {
  return fs.readdirSync(fixtureRoot)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
}

function readFixtures() {
  return fixtureFiles().map((file) => ({ file, fixture: readFixture(file) }));
}

function fixtureByCaseId(fixtures, caseId) {
  const match = fixtures.find(({ fixture }) => fixture.caseId === caseId);
  assert.ok(match, `missing fixture case ${caseId}`);
  return match.fixture;
}

function walkValues(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkValues(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walkValues(child, visit);
    }
  }
}

function existingReasonCategories() {
  return new Set(
    fs.readdirSync(verificationFixtureRoot)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(fs.readFileSync(path.join(verificationFixtureRoot, file), 'utf8')))
      .map((fixture) => fixture.expected.reasonCategory)
      .filter(Boolean)
  );
}

test('trusted-key resolver fixture inventory is exact and deterministic', () => {
  assert.deepEqual(fixtureFiles(), expectedFixtureFiles);
  assert.equal(new Set(fixtureFiles()).size, 12);

  const fixtures = readFixtures();
  const ids = fixtures.map(({ fixture }) => fixture.caseId);
  assert.equal(fixtures.length, 12);
  assert.equal(new Set(ids).size, 12);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
});

test('trusted-key resolver fixtures expose only bounded contract values', () => {
  const reasonCategories = existingReasonCategories();

  for (const { file, fixture } of readFixtures()) {
    assert.equal(typeof fixture.description, 'string', `${file} description`);
    assert.equal(typeof fixture.input, 'object', `${file} input`);
    assert.equal(typeof fixture.expected, 'object', `${file} expected`);
    assert.equal(Array.isArray(fixture.nonClaims), true, `${file} nonClaims`);
    assert.equal(allowedStates.has(fixture.expected.keyState), true, `${file} keyState`);
    assert.equal(
      fixture.expected.reasonCategory === undefined || reasonCategories.has(fixture.expected.reasonCategory),
      true,
      `${file} reasonCategory`
    );
    assert.equal(
      fixture.nonClaims.every((claim) => allowedNonClaims.has(claim)),
      true,
      `${file} nonClaims`
    );
  }
});

test('trusted-key resolver fixture outcomes match the merged state contract', () => {
  const fixtures = readFixtures();

  for (const [caseId, [expectedState, expectedReason]] of expectedOutcomes) {
    const fixture = fixtureByCaseId(fixtures, caseId);
    assert.equal(fixture.expected.keyState, expectedState, `${caseId} keyState`);
    assert.equal(fixture.expected.reasonCategory, expectedReason, `${caseId} reasonCategory`);
  }
});

test('trusted-key resolver fail-closed cases encode their intended boundaries', () => {
  const fixtures = readFixtures();
  const expectedMalformed = [
    'resolver-malformed-key-reference',
    'resolver-unknown-top-level-metadata',
    'resolver-nested-secret-private-key-material',
    'resolver-nested-network-provider-metadata',
    'resolver-unsafe-key-material-alias',
    'resolver-ambiguous-duplicate-record'
  ];

  for (const caseId of expectedMalformed) {
    assert.equal(fixtureByCaseId(fixtures, caseId).expected.keyState, 'malformed', caseId);
    assert.equal(
      fixtureByCaseId(fixtures, caseId).expected.reasonCategory,
      'malformed_trusted_key_record',
      `${caseId} reasonCategory`
    );
  }

  assert.equal(fixtureByCaseId(fixtures, 'resolver-malformed-key-reference').input.keyReference, '');
  assert.equal(
    fixtureByCaseId(fixtures, 'resolver-expired-key-metadata-boundary').expected.keyState,
    'expired'
  );
  assert.equal(
    fixtureByCaseId(fixtures, 'resolver-expired-key-metadata-boundary').input.trustedKeyRecord.expiresAt < fixedEvaluationTime,
    true
  );
  assert.equal(
    fixtureByCaseId(fixtures, 'resolver-ambiguous-duplicate-record').input.trustedKeyRecords.length,
    2
  );
  assert.equal(fixtureByCaseId(fixtures, 'resolver-lookup-unavailable').expected.keyState, 'unavailable');
});

test('trusted-key resolver fixtures use one fixed evaluation time and deterministic repeat input', () => {
  for (const { file, fixture } of readFixtures()) {
    const inputs = Array.isArray(fixture.input.equivalentInputs)
      ? fixture.input.equivalentInputs
      : [fixture.input];

    assert.ok(inputs.length > 0, `${file} inputs`);
    assert.equal(inputs.every((input) => input.evaluationTime === fixedEvaluationTime), true, `${file} time`);
  }

  const repeat = fixtureByCaseId(readFixtures(), 'resolver-deterministic-repeat');
  assert.equal(repeat.input.evaluationCount, 2);
  assert.deepEqual(repeat.input.equivalentInputs[0], repeat.input.equivalentInputs[1]);
  assert.equal(repeat.expected.keyState, 'active');
});

test('trusted-key resolver fixtures are synthetic and preserve nonClaims boundaries', () => {
  const fixtures = readFixtures().map(({ fixture }) => fixture);
  const corpusText = JSON.stringify(fixtures);
  const union = new Set(fixtures.flatMap((fixture) => fixture.nonClaims));

  for (const claim of allowedNonClaims) assert.equal(union.has(claim), true, claim);
  assert.equal(/BEGIN (?:PRIVATE|PUBLIC|CERTIFICATE) KEY/.test(corpusText), false);
  assert.equal(/ssh-rsa|credential\s*[:=]|token\s*[:=]|password\s*[:=]/i.test(corpusText), false);
  assert.equal(/https?:\/\/(?!resolver\.example\.invalid)/i.test(corpusText), false);
  const capabilityFields = [];
  for (const fixture of fixtures) {
    walkValues(fixture, (key) => {
      if (/^(signature|signatureEvidence|crypto)$/i.test(key)) capabilityFields.push(key);
    });
  }
  assert.deepEqual(capabilityFields, []);

  for (const { file, fixture } of readFixtures()) {
    walkValues(fixture, (key, value) => {
      if (forbiddenMaterialKeys.test(key)) {
        const serialized = JSON.stringify(value);
        assert.match(serialized, /fixture-(?:private-key|key-material)|resolver\.example\.invalid/i, `${file} ${key}`);
      }
    });
  }
});
