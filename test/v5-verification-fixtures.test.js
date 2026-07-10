'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'verification');
const expectedCases = [
  ['verified-supported-algorithm', 'verified', 'signature_valid'],
  ['missing-signature-evidence', 'not_verified', 'missing_signature_evidence'],
  ['malformed-signature-evidence', 'not_verified', 'malformed_signature_evidence'],
  ['payload-digest-mismatch', 'not_verified', 'payload_digest_mismatch'],
  ['unsupported-algorithm', 'not_verified', 'unsupported_algorithm'],
  ['unknown-key', 'not_verified', 'unknown_key'],
  ['revoked-key', 'not_verified', 'revoked_key'],
  ['expired-key-metadata', 'not_verified', 'expired_key_metadata'],
  ['key-lookup-unavailable', 'not_verified', 'key_lookup_unavailable'],
  ['malformed-trusted-key-record', 'not_verified', 'malformed_trusted_key_record'],
  ['payload-identity-mismatch', 'not_verified', 'payload_identity_mismatch'],
  ['forbidden-trust-claim', 'not_verified', 'forbidden_trust_claim'],
  ['forbidden-authorization-claim', 'not_verified', 'forbidden_authorization_claim'],
  ['forbidden-exchange-claim', 'not_verified', 'forbidden_exchange_claim'],
  ['deterministic-repeat', 'verified', 'signature_valid']
];
const allowedStatuses = new Set(['verified', 'not_verified']);
const allowedReasons = new Set(expectedCases.map(([, , reason]) => reason));
const expectedNonClaims = new Set([
  'action_authorization_not_established',
  'external_exchange_not_established',
  'identity_verification_not_established',
  'package_trust_not_established',
  'production_crypto_not_claimed'
]);
const forbiddenMaterial = [
  'BEGIN PRIVATE KEY',
  'BEGIN PUBLIC KEY',
  'BEGIN CERTIFICATE',
  '-----BEGIN',
  'ssh-rsa',
  'credential',
  'https://',
  'http://',
  'Date.now()',
  'Math.random()'
];

function fixtureFiles() {
  return fs.readdirSync(fixtureRoot).sort();
}

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fixtureByCaseId(fixtures, caseId) {
  return fixtures.find(({ fixture }) => fixture.caseId === caseId).fixture;
}

test('verification fixture inventory is exact and deterministic', () => {
  const files = fixtureFiles();
  assert.equal(files.length, 15);
  assert.equal(files.every((file) => file.endsWith('.json')), true);
  assert.deepEqual(
    files.map((file) => readFixture(file).caseId),
    expectedCases.map(([caseId]) => caseId)
  );
});

test('verification fixtures expose the common envelope and bounded results', () => {
  const fixtures = fixtureFiles().map((file) => ({ file, fixture: readFixture(file) }));
  const ids = fixtures.map(({ fixture }) => fixture.caseId);

  assert.equal(new Set(ids).size, 15);
  for (const { file, fixture } of fixtures) {
    assert.equal(typeof fixture.caseId, 'string', `${file} caseId`);
    assert.notEqual(fixture.caseId.trim(), '', `${file} caseId`);
    assert.equal(typeof fixture.description, 'string', `${file} description`);
    assert.notEqual(fixture.description.trim(), '', `${file} description`);
    assert.equal(isPlainObject(fixture.input), true, `${file} input`);
    assert.equal(isPlainObject(fixture.expected), true, `${file} expected`);
    assert.equal(Array.isArray(fixture.nonClaims), true, `${file} nonClaims`);
    assert.equal(fixture.nonClaims.every((value) => typeof value === 'string' && value.trim()), true);
    assert.equal(allowedStatuses.has(fixture.expected.verificationStatus), true, `${file} status`);
    assert.equal(allowedReasons.has(fixture.expected.reasonCategory), true, `${file} reason`);
  }
});

test('verification fixture expectations match the merged case contract', () => {
  const fixtures = fixtureFiles().map((file) => ({ file, fixture: readFixture(file) }));

  for (const [caseId, status, reason] of expectedCases) {
    const fixture = fixtureByCaseId(fixtures, caseId);
    assert.equal(fixture.expected.verificationStatus, status, `${caseId} status`);
    assert.equal(fixture.expected.reasonCategory, reason, `${caseId} reason`);
  }
});

test('negative fixtures encode their intended bounded condition', () => {
  const fixtures = fixtureFiles().map((file) => ({ file, fixture: readFixture(file) }));
  const missing = fixtureByCaseId(fixtures, 'missing-signature-evidence');
  assert.equal(Object.hasOwn(missing.input, 'signature'), false);

  const malformed = fixtureByCaseId(fixtures, 'malformed-signature-evidence');
  assert.equal(malformed.input.signature, 'synthetic-signature-malformed:v1:case-03');

  const digestMismatch = fixtureByCaseId(fixtures, 'payload-digest-mismatch');
  assert.notEqual(digestMismatch.input.payload.payloadDigest, digestMismatch.input.payload.expectedPayloadDigest);

  const unsupported = fixtureByCaseId(fixtures, 'unsupported-algorithm');
  assert.notEqual(unsupported.input.algorithm, 'test-structural-v1');

  for (const [caseId, state] of [
    ['unknown-key', 'unknown'],
    ['revoked-key', 'revoked'],
    ['expired-key-metadata', 'expired'],
    ['key-lookup-unavailable', 'unavailable'],
    ['malformed-trusted-key-record', 'malformed']
  ]) {
    assert.equal(fixtureByCaseId(fixtures, caseId).input.trustedKeyMetadata.status, state);
  }

  const expired = fixtureByCaseId(fixtures, 'expired-key-metadata');
  assert.equal(expired.input.trustedKeyMetadata.expiresAt < expired.input.evaluationTime, true);

  const malformedKey = fixtureByCaseId(fixtures, 'malformed-trusted-key-record');
  assert.equal(Array.isArray(malformedKey.input.trustedKeyMetadata.keyReference), true);

  assert.equal(Object.hasOwn(fixtureByCaseId(fixtures, 'payload-identity-mismatch').input.payload, 'signedPayloadId'), true);
  assert.equal(Object.hasOwn(fixtureByCaseId(fixtures, 'forbidden-trust-claim').input, 'claims'), true);
  assert.equal(Object.hasOwn(fixtureByCaseId(fixtures, 'forbidden-authorization-claim').input, 'claims'), true);
  assert.equal(Object.hasOwn(fixtureByCaseId(fixtures, 'forbidden-exchange-claim').input, 'claims'), true);
});

test('positive and repeat fixtures preserve bounded evidence and determinism', () => {
  const fixtures = fixtureFiles().map((file) => ({ file, fixture: readFixture(file) }));
  const positive = fixtureByCaseId(fixtures, 'verified-supported-algorithm');
  assert.equal(positive.input.algorithm, 'test-structural-v1');
  assert.equal(positive.input.payload.canonicalization, 'json-stable-v1');
  assert.equal(positive.input.payload.payloadDigest, 'fixture-digest:verified-01');
  assert.equal(positive.input.signature, 'synthetic-signature-placeholder:v1:case-01');
  assert.equal(positive.input.keyReference, 'test-key:active-01');
  assert.equal(positive.input.trustedKeyMetadata.status, 'active');
  assert.equal(new Date(positive.input.evaluationTime).toISOString(), positive.input.evaluationTime);
  for (const claim of expectedNonClaims) assert.equal(positive.nonClaims.includes(claim), true, claim);

  const repeat = fixtureByCaseId(fixtures, 'deterministic-repeat');
  assert.equal(repeat.input.evaluationCount, 2);
  assert.deepEqual(repeat.input.equivalentInputs[0], repeat.input.equivalentInputs[1]);
  assert.equal(repeat.expected.verificationStatus, 'verified');
  assert.equal(repeat.expected.reasonCategory, 'signature_valid');
});

test('verification fixture corpus is synthetic and preserves its current nonClaims union', () => {
  const fixtures = fixtureFiles().map(readFixture);
  const corpusText = JSON.stringify(fixtures);
  const union = new Set(fixtures.flatMap((fixture) => fixture.nonClaims));

  for (const claim of expectedNonClaims) assert.equal(union.has(claim), true, claim);
  for (const marker of forbiddenMaterial) assert.equal(corpusText.includes(marker), false, marker);
  assert.equal(corpusText.includes('privateKey'), false);
  assert.equal(corpusText.includes('publicKey'), false);
  assert.equal(corpusText.includes('certificate'), false);
  assert.equal(corpusText.includes('resolver implementation'), false);
});
