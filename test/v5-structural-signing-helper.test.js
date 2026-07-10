'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  prepareStructuralSigning
} = require('../lib/v5/structural-signing-helper');

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'signing');
const fixtureFiles = fs
  .readdirSync(fixtureRoot)
  .filter((entry) => entry.endsWith('.json'))
  .sort();

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
}

function validCandidate() {
  return readFixture('valid-with-key-metadata.json');
}

function assertInvalid(result, reasonCategory) {
  assert.equal(result.ok, false);
  assert.equal(result.reason_category, reasonCategory);
  assert.equal(Object.hasOwn(result, 'signingMetadata'), false);
  for (const capabilityField of [
    'signature',
    'signed',
    'verified',
    'trusted',
    'authorized'
  ]) {
    assert.equal(Object.hasOwn(result, capabilityField), false);
  }
}

test('structural signing helper matches all 10 signing fixture contracts', () => {
  assert.equal(fixtureFiles.length, 10);

  for (const file of fixtureFiles) {
    const fixture = readFixture(file);
    const before = JSON.parse(JSON.stringify(fixture));
    const first = prepareStructuralSigning(fixture);
    const second = prepareStructuralSigning(fixture);

    assert.deepEqual(second, first, `${file} output must be deterministic`);
    assert.deepEqual(fixture, before, `${file} input must not be mutated`);
    assert.equal(first.status, fixture.expected.status, `${file} status mismatch`);
    assert.equal(
      first.reason_category,
      fixture.expected.reasonCategory,
      `${file} reason category mismatch`
    );

    if (fixture.fixtureType === 'valid_signing_candidate') {
      assert.equal(first.ok, true);
      assert.equal(first.signingMetadata.packageId, fixture.signingInput.packageId);
      assert.equal(first.signingMetadata.keyId, fixture.signingInput.keyId);
      assert.equal(first.signingMetadata.algorithm, fixture.signingInput.algorithm);
      assert.equal(
        first.signingMetadata.contentRef,
        fixture.signingInput.payload.contentRef
      );
      assert.deepEqual(first.signingMetadata.nonClaims, fixture.nonClaims);
      if (fixture.signingInput.payload.payloadDigest !== undefined) {
        assert.equal(
          first.signingMetadata.payloadDigest,
          fixture.signingInput.payload.payloadDigest
        );
      }
      if (fixture.signingInput.keyMetadata !== undefined) {
        assert.deepEqual(first.signingMetadata.keyMetadata, fixture.signingInput.keyMetadata);
      }
    } else {
      assertInvalid(first, fixture.expected.reasonCategory);
    }
  }
});

test('structural signing helper rejects recursive key material and PEM content', () => {
  const nestedArray = validCandidate();
  nestedArray.signingInput.keyMetadata.privateKey = [{ bytes: 'secret' }];
  assertInvalid(prepareStructuralSigning(nestedArray), 'unknown_key_metadata_field');

  const pem = validCandidate();
  pem.signingInput.keyMetadata.material = '-----BEGIN PRIVATE KEY-----';
  assertInvalid(prepareStructuralSigning(pem), 'unknown_key_metadata_field');

  for (const key of ['private_key', 'PrivateKey', 'publicKey', 'credential', 'token']) {
    const candidate = validCandidate();
    candidate.signingInput.keyMetadata[key] = 'forbidden';
    assertInvalid(prepareStructuralSigning(candidate), 'unknown_key_metadata_field');
  }
});

test('structural signing helper rejects malformed and capability-shaped claims', () => {
  const nonBoolean = validCandidate();
  nonBoolean.claims = { verificationRuntime: 'enabled' };
  assertInvalid(prepareStructuralSigning(nonBoolean), 'malformed_claims');

  const trust = validCandidate();
  trust.verified = true;
  assertInvalid(prepareStructuralSigning(trust), 'unknown_top_level_field');

  const authorization = validCandidate();
  authorization.signingInput.authorized = true;
  assertInvalid(prepareStructuralSigning(authorization), 'unknown_signing_input_field');
});

test('structural signing helper returns deterministic JSON-safe failures', () => {
  const bigint = validCandidate();
  bigint.signingInput.keyMetadata.ownerType = 1n;
  const bigintResult = prepareStructuralSigning(bigint);
  assertInvalid(bigintResult, 'invalid_json_value');
  assert.doesNotThrow(() => JSON.stringify(bigintResult));

  const circular = validCandidate();
  circular.signingInput.keyMetadata.loop = circular;
  const circularResult = prepareStructuralSigning(circular);
  assertInvalid(circularResult, 'invalid_json_value');
  assert.doesNotThrow(() => JSON.stringify(circularResult));

  for (const value of [() => {}, Symbol('unsafe'), new Date(0)]) {
    const candidate = validCandidate();
    candidate.signingInput.keyMetadata.ownerType = value;
    assertInvalid(prepareStructuralSigning(candidate), 'invalid_json_value');
  }
});

test('structural signing helper is deterministic and does not mutate input', () => {
  const candidate = validCandidate();
  const before = JSON.parse(JSON.stringify(candidate));
  const first = prepareStructuralSigning(candidate);
  const second = prepareStructuralSigning(candidate);

  assert.deepEqual(first, second);
  assert.deepEqual(candidate, before);
  assert.doesNotThrow(() => JSON.stringify(first));
});
