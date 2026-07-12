'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const bindingRoot = path.join(__dirname, 'fixtures', 'v5', 'trusted-key-resolver-binding');
const resolverRoot = path.join(__dirname, 'fixtures', 'v5', 'trusted-key-resolver');
const cryptoRoot = path.join(__dirname, 'fixtures', 'v5', 'cryptographic-adapter');

const expectedBindingFiles = [
  '01-active-buffer-bound-key.json',
  '02-active-uint8array-bound-key.json',
  '03-active-opaque-44-byte-key.json',
  '04-active-missing-key.json',
  '05-active-null-key.json',
  '06-active-string-key.json',
  '07-active-key-one-byte-short.json',
  '08-active-key-one-byte-long.json',
  '09-revoked-without-key.json',
  '10-revoked-with-valid-key.json',
  '11-revoked-with-malformed-present-key.json',
  '12-expired-with-valid-key.json',
  '13-unavailable-with-valid-key.json',
  '14-unknown-empty-records.json',
  '15-unknown-reference-mismatch-same-key.json',
  '16-ambiguous-duplicate-same-key.json',
  '17-ambiguous-duplicate-different-keys.json',
  '18-malformed-record-forbidden-public-key-field.json',
  '19-malformed-root-parallel-public-key.json',
  '20-malformed-nonmatching-record-before-selection.json'
];

const expectedResolverFiles = [
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

const nonClaims = [
  'package_trust_not_established',
  'action_authorization_not_established',
  'identity_verification_not_established',
  'external_exchange_not_established',
  'production_crypto_not_claimed'
];

const expectedResults = new Map([
  ['01-active-buffer-bound-key', ['active', null]],
  ['02-active-uint8array-bound-key', ['active', null]],
  ['03-active-opaque-44-byte-key', ['active', null]],
  ['04-active-missing-key', ['malformed', 'malformed_trusted_key_record']],
  ['05-active-null-key', ['malformed', 'malformed_trusted_key_record']],
  ['06-active-string-key', ['malformed', 'malformed_trusted_key_record']],
  ['07-active-key-one-byte-short', ['malformed', 'malformed_trusted_key_record']],
  ['08-active-key-one-byte-long', ['malformed', 'malformed_trusted_key_record']],
  ['09-revoked-without-key', ['revoked', 'revoked_key']],
  ['10-revoked-with-valid-key', ['revoked', 'revoked_key']],
  ['11-revoked-with-malformed-present-key', ['malformed', 'malformed_trusted_key_record']],
  ['12-expired-with-valid-key', ['expired', 'expired_key_metadata']],
  ['13-unavailable-with-valid-key', ['unavailable', 'key_lookup_unavailable']],
  ['14-unknown-empty-records', ['unknown', 'unknown_key']],
  ['15-unknown-reference-mismatch-same-key', ['unknown', 'unknown_key']],
  ['16-ambiguous-duplicate-same-key', ['malformed', 'malformed_trusted_key_record']],
  ['17-ambiguous-duplicate-different-keys', ['malformed', 'malformed_trusted_key_record']],
  ['18-malformed-record-forbidden-public-key-field', ['malformed', 'malformed_trusted_key_record']],
  ['19-malformed-root-parallel-public-key', ['malformed', 'malformed_trusted_key_record']],
  ['20-malformed-nonmatching-record-before-selection', ['malformed', 'malformed_trusted_key_record']]
]);

const rootKeys = ['caseId', 'description', 'expected', 'input', 'nonClaims'];
const normalInputKeys = ['evaluationTime', 'keyReference', 'records'];
const activeExpectedKeys = ['keyReference', 'keyState', 'publicKeySpkiDerHex'];
const nonActiveExpectedKeys = ['keyState', 'reasonCategory'];
const descriptorKinds = new Set(['buffer-hex', 'uint8array-hex', 'raw-json']);
const byteDescriptorKinds = new Set(['buffer-hex', 'uint8array-hex']);

function ownKeys(value) {
  return Object.keys(value).sort();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureHash(root, file) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(root, file)))
    .digest('hex');
}

function directoryFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    assert.equal(entry.isFile(), true, `${root}: ${entry.name} must be a file`);
    assert.equal(entry.name.startsWith('.'), false, `${root}: hidden entry ${entry.name}`);
    assert.equal(entry.name.endsWith('.json'), true, `${root}: non-JSON entry ${entry.name}`);
  }
  return entries.map((entry) => entry.name).sort();
}

function loadFixture(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function loadBindingCorpus() {
  return expectedBindingFiles.map((file) => ({
    file,
    fixture: loadFixture(bindingRoot, file)
  }));
}

function byCaseId(corpus, caseId) {
  const row = corpus.find((entry) => entry.fixture.caseId === caseId);
  assert.ok(row, `missing case ${caseId}`);
  return row.fixture;
}

function decodeHex(value, label) {
  assert.equal(typeof value, 'string', `${label}: string`);
  assert.match(value, /^[0-9a-f]+$/, `${label}: strict lowercase hex`);
  assert.equal(value.length % 2, 0, `${label}: even length`);
  const decoded = Buffer.from(value, 'hex');
  assert.equal(decoded.toString('hex'), value, `${label}: round trip`);
  return decoded;
}

function validateDescriptor(descriptor, label) {
  assert.ok(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor), `${label}: object`);
  assert.ok(descriptorKinds.has(descriptor.kind), `${label}: exact kind`);
  if (byteDescriptorKinds.has(descriptor.kind)) {
    assert.deepEqual(ownKeys(descriptor), ['hex', 'kind'], `${label}: exact byte keys`);
    decodeHex(descriptor.hex, `${label}.hex`);
  } else {
    assert.deepEqual(ownKeys(descriptor), ['kind', 'value'], `${label}: exact raw keys`);
  }
}

function collectDescriptorLocations(value, trail = [], locations = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectDescriptorLocations(child, [...trail, index], locations));
    return locations;
  }
  if (!value || typeof value !== 'object') {
    return locations;
  }
  if (Object.hasOwn(value, 'kind')) {
    locations.push({ descriptor: value, trail });
  }
  for (const [key, child] of Object.entries(value)) {
    collectDescriptorLocations(child, [...trail, key], locations);
  }
  return locations;
}

function materializeDescriptor(descriptor) {
  validateDescriptor(descriptor, 'descriptor');
  if (descriptor.kind === 'buffer-hex') {
    return Buffer.from(decodeHex(descriptor.hex, 'buffer descriptor'));
  }
  if (descriptor.kind === 'uint8array-hex') {
    const bytes = decodeHex(descriptor.hex, 'uint8array descriptor');
    return new Uint8Array(bytes);
  }
  return descriptor.value;
}

function materializeFixtureInput(input) {
  const copied = clone(input);
  function visit(value) {
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = key === 'publicKeySpkiDer'
        ? materializeDescriptor(child)
        : visit(child);
    }
    return result;
  }
  return visit(copied);
}

function assertExpected(fixture, keyState, reasonCategory) {
  if (keyState === 'active') {
    assert.deepEqual(ownKeys(fixture.expected), activeExpectedKeys);
    assert.equal(fixture.expected.keyState, 'active');
    assert.equal(fixture.expected.keyReference, fixture.input.keyReference);
    assert.equal(decodeHex(fixture.expected.publicKeySpkiDerHex, `${fixture.caseId}: expected key`).length, 44);
    assert.equal(Object.hasOwn(fixture.expected, 'reasonCategory'), false);
  } else {
    assert.deepEqual(ownKeys(fixture.expected), nonActiveExpectedKeys);
    assert.deepEqual(fixture.expected, { keyState, reasonCategory });
    for (const key of ['keyReference', 'publicKeySpkiDer', 'publicKeySpkiDerHex', 'descriptor', 'records', 'explanation']) {
      assert.equal(Object.hasOwn(fixture.expected, key), false, `${fixture.caseId}: no ${key}`);
    }
  }
}

function recordKeyDescriptor(fixture, index = 0) {
  return fixture.input.records[index].publicKeySpkiDer;
}

test('binding and original resolver corpora remain exact and separate', () => {
  assert.equal(fs.statSync(bindingRoot).isDirectory(), true);
  assert.equal(fs.statSync(resolverRoot).isDirectory(), true);
  const bindingFiles = directoryFiles(bindingRoot);
  const resolverFiles = directoryFiles(resolverRoot);
  assert.deepEqual(bindingFiles, expectedBindingFiles);
  assert.deepEqual(resolverFiles, expectedResolverFiles);
  assert.equal(new Set(bindingFiles).size, 20);
  assert.equal(new Set(resolverFiles).size, 12);
  assert.deepEqual(bindingFiles, [...bindingFiles].sort());
  assert.deepEqual(resolverFiles, [...resolverFiles].sort());
  assert.equal(bindingFiles.some((file) => resolverFiles.includes(file)), false);
});

test('all 20 JSON fixtures parse repeatedly with exact identity and envelope', () => {
  const first = loadBindingCorpus();
  const second = loadBindingCorpus();
  assert.equal(first.length, 20);
  assert.deepEqual(second, first);
  const caseIds = new Set();

  for (const { file, fixture } of first) {
    assert.equal(fixture.caseId, path.basename(file, '.json'));
    assert.equal(caseIds.has(fixture.caseId), false, `${file}: duplicate caseId`);
    caseIds.add(fixture.caseId);
    assert.deepEqual(ownKeys(fixture), rootKeys);
    assert.equal(typeof fixture.description, 'string');
    assert.equal(fixture.description.trim(), fixture.description);
    assert.ok(fixture.description.length > 0 && fixture.description.length <= 256);
    assert.ok(fixture.input && typeof fixture.input === 'object' && !Array.isArray(fixture.input));
    assert.ok(fixture.expected && typeof fixture.expected === 'object' && !Array.isArray(fixture.expected));
    assert.ok(JSON.stringify(fixture.expected).length <= 512);
    assert.deepEqual(fixture.nonClaims, nonClaims);
  }

  assert.equal(caseIds.size, 20);
  assert.deepEqual([...caseIds], expectedBindingFiles.map((file) => path.basename(file, '.json')));
});

test('fixture input roots and descriptor locations are strictly confined', () => {
  for (const { fixture } of loadBindingCorpus()) {
    const allowed = fixture.caseId === '19-malformed-root-parallel-public-key'
      ? [...normalInputKeys, 'publicKeySpkiDer'].sort()
      : normalInputKeys;
    assert.deepEqual(ownKeys(fixture.input), allowed, `${fixture.caseId}: input keys`);

    for (const forbidden of ['publicKeySpkiDerHex', 'keyState', 'cryptographicState', 'bindingVerdict', 'provider', 'keyStore', 'networkEndpoint']) {
      assert.equal(Object.hasOwn(fixture.input, forbidden), false, `${fixture.caseId}: no root ${forbidden}`);
    }

    const locations = collectDescriptorLocations(fixture);
    for (const { descriptor, trail } of locations) {
      assert.equal(trail.at(-1), 'publicKeySpkiDer', `${fixture.caseId}: descriptor location`);
      assert.equal(trail.includes('expected'), false, `${fixture.caseId}: no expected descriptor`);
      validateDescriptor(descriptor, `${fixture.caseId}:${trail.join('.')}`);
    }

    function inspectPublicKeyFields(value, trail = []) {
      if (Array.isArray(value)) {
        value.forEach((child, index) => inspectPublicKeyFields(child, [...trail, index]));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'publicKeySpkiDer') {
          validateDescriptor(child, `${fixture.caseId}:${[...trail, key].join('.')}`);
        }
        inspectPublicKeyFields(child, [...trail, key]);
      }
    }
    inspectPublicKeyFields(fixture.input);
  }
});

test('descriptor validation and materialization are exact, deterministic, and immutable', () => {
  for (const { fixture } of loadBindingCorpus()) {
    const snapshot = clone(fixture);
    const first = materializeFixtureInput(fixture.input);
    const second = materializeFixtureInput(fixture.input);
    assert.deepEqual(first, second, `${fixture.caseId}: deterministic materialization`);

    const firstRecords = first.records || [];
    const secondRecords = second.records || [];
    for (let index = 0; index < firstRecords.length; index += 1) {
      const left = firstRecords[index].publicKeySpkiDer;
      const right = secondRecords[index].publicKeySpkiDer;
      if (Buffer.isBuffer(left)) {
        assert.equal(Buffer.isBuffer(right), true);
        assert.notEqual(left, right);
        assert.deepEqual(left, right);
      } else if (left instanceof Uint8Array) {
        assert.equal(right instanceof Uint8Array, true);
        assert.equal(Buffer.isBuffer(left), false);
        assert.notEqual(left, right);
        assert.equal(left.byteLength, left.length);
        assert.deepEqual(left, right);
      }
    }

    assert.deepEqual(fixture, snapshot, `${fixture.caseId}: fixture immutability`);
    assert.equal(collectDescriptorLocations(first).length, 0, `${fixture.caseId}: no runtime descriptor`);
  }

  const first = byCaseId(loadBindingCorpus(), '01-active-buffer-bound-key');
  const second = byCaseId(loadBindingCorpus(), '02-active-uint8array-bound-key');
  const firstSnapshot = clone(first);
  materializeFixtureInput(second.input).records[0].publicKeySpkiDer[0] ^= 0xff;
  assert.deepEqual(first, firstSnapshot, 'materializing one fixture cannot mutate another');
});

test('hex encodings and exact decoded-length matrix remain canonical', () => {
  const corpus = loadBindingCorpus();
  const lengths = new Map([
    ['01-active-buffer-bound-key', 44],
    ['02-active-uint8array-bound-key', 44],
    ['03-active-opaque-44-byte-key', 44],
    ['07-active-key-one-byte-short', 43],
    ['08-active-key-one-byte-long', 45]
  ]);

  for (const { fixture } of corpus) {
    for (const { descriptor } of collectDescriptorLocations(fixture.input)) {
      validateDescriptor(descriptor, fixture.caseId);
      if (byteDescriptorKinds.has(descriptor.kind)) {
        assert.equal(descriptor.hex.includes('0x'), false);
        assert.equal(/[A-F\s:_-]/.test(descriptor.hex), false);
      }
    }
    if (fixture.expected.keyState !== 'active') {
      assert.equal(Object.hasOwn(fixture.expected, 'publicKeySpkiDerHex'), false);
    }
  }

  for (const [caseId, length] of lengths) {
    const fixture = byCaseId(corpus, caseId);
    assert.equal(decodeHex(recordKeyDescriptor(fixture).hex, caseId).length, length);
  }
  assert.notEqual(lengths.get('07-active-key-one-byte-short'), 44);
  assert.notEqual(lengths.get('08-active-key-one-byte-long'), 44);
});

test('public key provenance is anchored to canonical public-only fixtures', () => {
  const corpus = loadBindingCorpus();
  const rfcSource = loadFixture(cryptoRoot, '01-valid-rfc8032-one-octet.json');
  const distinctSource = loadFixture(cryptoRoot, '04-invalid-different-ed25519-public-key.json');
  const rfc = decodeHex(rfcSource.input.publicKeySpkiDerHex, 'RFC source key');
  const distinct = decodeHex(distinctSource.input.publicKeySpkiDerHex, 'distinct source key');

  assert.equal(rfcSource.caseId, 'valid-rfc8032-one-octet');
  assert.equal(rfcSource.provenance.vectorId, 'TEST 2');
  assert.equal(rfc.length, 44);
  assert.equal(rfc.at(-1), 0x0c);
  assert.equal(rfcSource.input.publicKeySpkiDerHex.length, 88);
  assert.equal(distinctSource.caseId, 'invalid-different-ed25519-public-key');
  assert.equal(distinct.length, 44);
  assert.equal(distinctSource.input.publicKeySpkiDerHex.length, 88);
  assert.equal(rfc.equals(distinct), false);

  const case01 = byCaseId(corpus, '01-active-buffer-bound-key');
  const case02 = byCaseId(corpus, '02-active-uint8array-bound-key');
  const case03 = byCaseId(corpus, '03-active-opaque-44-byte-key');
  const case17 = byCaseId(corpus, '17-ambiguous-duplicate-different-keys');
  assert.equal(recordKeyDescriptor(case01).hex, rfcSource.input.publicKeySpkiDerHex);
  assert.equal(recordKeyDescriptor(case02).hex, rfcSource.input.publicKeySpkiDerHex);
  assert.equal(case01.expected.publicKeySpkiDerHex, rfcSource.input.publicKeySpkiDerHex);
  assert.equal(case17.input.records[1].publicKeySpkiDer.hex, distinctSource.input.publicKeySpkiDerHex);
  assert.equal(decodeHex(recordKeyDescriptor(case03).hex, 'opaque key').length, 44);
  assert.match(case03.description, /opaque/i);
  assert.doesNotMatch(case03.description, /valid DER|cryptographically valid|verified/i);
  assert.deepEqual(case03.nonClaims, nonClaims);
});

test('expected output vocabulary and confinement match the existing resolver contract', () => {
  const originalCorpus = expectedResolverFiles.map((file) => loadFixture(resolverRoot, file));
  const existingStates = new Set(originalCorpus.map((fixture) => fixture.expected.keyState));
  const existingReasons = new Set(originalCorpus
    .map((fixture) => fixture.expected.reasonCategory)
    .filter(Boolean));
  assert.deepEqual(existingStates, new Set(['active', 'unknown', 'revoked', 'expired', 'unavailable', 'malformed']));
  assert.deepEqual(existingReasons, new Set([
    'unknown_key',
    'revoked_key',
    'expired_key_metadata',
    'key_lookup_unavailable',
    'malformed_trusted_key_record'
  ]));

  for (const { fixture } of loadBindingCorpus()) {
    const [state, reason] = expectedResults.get(fixture.caseId);
    assert.ok(existingStates.has(state), `${fixture.caseId}: existing state`);
    if (reason !== null) assert.ok(existingReasons.has(reason), `${fixture.caseId}: existing reason`);
    assertExpected(fixture, state, reason);
    const serialized = JSON.stringify(fixture.expected).toLowerCase();
    for (const forbidden of ['error', 'stack', 'exception', 'trustscore', 'authorized', 'authorizationresult']) {
      assert.equal(serialized.includes(forbidden), false, `${fixture.caseId}: no ${forbidden}`);
    }
  }
});

test('all 20 case semantics remain individually pinned', () => {
  const corpus = loadBindingCorpus();
  const rfc = loadFixture(cryptoRoot, '01-valid-rfc8032-one-octet.json').input.publicKeySpkiDerHex;
  const distinct = loadFixture(cryptoRoot, '04-invalid-different-ed25519-public-key.json').input.publicKeySpkiDerHex;
  const malformed = { keyState: 'malformed', reasonCategory: 'malformed_trusted_key_record' };

  const c01 = byCaseId(corpus, '01-active-buffer-bound-key');
  assert.equal(recordKeyDescriptor(c01).kind, 'buffer-hex'); assert.equal(recordKeyDescriptor(c01).hex, rfc);
  const c02 = byCaseId(corpus, '02-active-uint8array-bound-key');
  assert.equal(recordKeyDescriptor(c02).kind, 'uint8array-hex'); assert.equal(recordKeyDescriptor(c02).hex, rfc);
  const c03 = byCaseId(corpus, '03-active-opaque-44-byte-key');
  assert.equal(decodeHex(recordKeyDescriptor(c03).hex, c03.caseId).length, 44);
  const c04 = byCaseId(corpus, '04-active-missing-key');
  assert.equal(Object.hasOwn(c04.input.records[0], 'publicKeySpkiDer'), false); assert.deepEqual(c04.expected, malformed);
  const c05 = byCaseId(corpus, '05-active-null-key');
  assert.deepEqual(recordKeyDescriptor(c05), { kind: 'raw-json', value: null }); assert.deepEqual(c05.expected, malformed);
  const c06 = byCaseId(corpus, '06-active-string-key');
  assert.deepEqual(recordKeyDescriptor(c06), { kind: 'raw-json', value: 'synthetic-key-value' }); assert.deepEqual(c06.expected, malformed);
  const c07 = byCaseId(corpus, '07-active-key-one-byte-short');
  assert.equal(decodeHex(recordKeyDescriptor(c07).hex, c07.caseId).length, 43); assert.deepEqual(c07.expected, malformed);
  const c08 = byCaseId(corpus, '08-active-key-one-byte-long');
  assert.equal(decodeHex(recordKeyDescriptor(c08).hex, c08.caseId).length, 45); assert.deepEqual(c08.expected, malformed);
  const c09 = byCaseId(corpus, '09-revoked-without-key');
  assert.equal(Object.hasOwn(c09.input.records[0], 'publicKeySpkiDer'), false); assert.deepEqual(c09.expected, { keyState: 'revoked', reasonCategory: 'revoked_key' });
  const c10 = byCaseId(corpus, '10-revoked-with-valid-key');
  assert.equal(decodeHex(recordKeyDescriptor(c10).hex, c10.caseId).length, 44); assert.deepEqual(c10.expected, c09.expected);
  const c11 = byCaseId(corpus, '11-revoked-with-malformed-present-key');
  assert.deepEqual(recordKeyDescriptor(c11), { kind: 'raw-json', value: null }); assert.deepEqual(c11.expected, malformed);
  const c12 = byCaseId(corpus, '12-expired-with-valid-key');
  assert.equal(Date.parse(c12.input.records[0].expiresAt), Date.parse(c12.input.evaluationTime)); assert.deepEqual(c12.expected, { keyState: 'expired', reasonCategory: 'expired_key_metadata' });
  const c13 = byCaseId(corpus, '13-unavailable-with-valid-key');
  assert.equal(decodeHex(recordKeyDescriptor(c13).hex, c13.caseId).length, 44); assert.deepEqual(c13.expected, { keyState: 'unavailable', reasonCategory: 'key_lookup_unavailable' });
  const c14 = byCaseId(corpus, '14-unknown-empty-records');
  assert.deepEqual(c14.input.records, []); assert.deepEqual(c14.expected, { keyState: 'unknown', reasonCategory: 'unknown_key' });
  const c15 = byCaseId(corpus, '15-unknown-reference-mismatch-same-key');
  assert.notEqual(c15.input.keyReference, c15.input.records[0].keyReference); assert.equal(recordKeyDescriptor(c15).hex, rfc); assert.deepEqual(c15.expected, c14.expected);
  const c16 = byCaseId(corpus, '16-ambiguous-duplicate-same-key');
  assert.equal(c16.input.records.length, 2); assert.equal(recordKeyDescriptor(c16, 0).hex, recordKeyDescriptor(c16, 1).hex); assert.deepEqual(c16.expected, malformed);
  const c17 = byCaseId(corpus, '17-ambiguous-duplicate-different-keys');
  assert.equal(c17.input.records.length, 2); assert.equal(recordKeyDescriptor(c17, 0).hex, rfc); assert.equal(recordKeyDescriptor(c17, 1).hex, distinct); assert.deepEqual(c17.expected, c16.expected);
  const c18 = byCaseId(corpus, '18-malformed-record-forbidden-public-key-field');
  assert.equal(c18.input.records[0].publicKeyPem, 'forbidden-test-value'); assert.doesNotMatch(c18.input.records[0].publicKeyPem, /-----BEGIN/); assert.deepEqual(c18.expected, malformed);
  const c19 = byCaseId(corpus, '19-malformed-root-parallel-public-key');
  validateDescriptor(c19.input.publicKeySpkiDer, c19.caseId); assert.deepEqual(c19.expected, malformed);
  const c20 = byCaseId(corpus, '20-malformed-nonmatching-record-before-selection');
  assert.equal(c20.input.records.length, 2); assert.equal(c20.input.records[0].keyReference, c20.input.keyReference); assert.notEqual(c20.input.records[1].keyReference, c20.input.keyReference); assert.deepEqual(recordKeyDescriptor(c20, 1), { kind: 'raw-json', value: null }); assert.deepEqual(c20.expected, malformed);
});

test('duplicate, reference mismatch, and whole-record precedence invariants are explicit', () => {
  const corpus = loadBindingCorpus();
  const c11 = byCaseId(corpus, '11-revoked-with-malformed-present-key');
  const c15 = byCaseId(corpus, '15-unknown-reference-mismatch-same-key');
  const c16 = byCaseId(corpus, '16-ambiguous-duplicate-same-key');
  const c17 = byCaseId(corpus, '17-ambiguous-duplicate-different-keys');
  const c20 = byCaseId(corpus, '20-malformed-nonmatching-record-before-selection');

  assert.deepEqual(c16.expected, c17.expected);
  assert.equal(c16.expected.keyState, 'malformed');
  assert.equal(c17.expected.keyState, 'malformed');
  assert.equal(c15.expected.keyState, 'unknown');
  assert.equal(recordKeyDescriptor(c15).hex, recordKeyDescriptor(byCaseId(corpus, '01-active-buffer-bound-key')).hex);
  assert.equal(c11.input.records[0].status, 'revoked');
  assert.deepEqual(recordKeyDescriptor(c11), { kind: 'raw-json', value: null });
  assert.deepEqual(c11.expected, { keyState: 'malformed', reasonCategory: 'malformed_trusted_key_record' });
  assert.equal(c20.input.records[0].keyReference, c20.input.keyReference);
  assert.notEqual(c20.input.records[1].keyReference, c20.input.keyReference);
  assert.deepEqual(recordKeyDescriptor(c20, 1), { kind: 'raw-json', value: null });
  assert.deepEqual(c20.expected, c11.expected);
});

test('secret-material scan is precise and nonClaims remain exact', () => {
  const forbiddenKey = /^(privateKey|private_key|privateSeed|signingSeed|pkcs8|password|credential|accessToken|apiToken|provider|keyStore|key_store|endpoint|database|environmentVariable)$/i;
  const forbiddenValue = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|private[ _-]?(?:key|seed)\s*[:=]|(?:access|api)[ _-]?token\s*[:=]|(?:password|credential)\s*[:=]|https?:\/\//i;

  function scan(value, fixture, trail = []) {
    if (Array.isArray(value)) {
      value.forEach((child, index) => scan(child, fixture, [...trail, index]));
      return;
    }
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string') {
        assert.doesNotMatch(value, forbiddenValue, `${fixture.caseId}:${trail.join('.')}`);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, forbiddenKey, `${fixture.caseId}:${[...trail, key].join('.')}`);
      if (key === 'publicKeyPem') {
        assert.equal(fixture.caseId, '18-malformed-record-forbidden-public-key-field');
        assert.equal(child, 'forbidden-test-value');
      }
      scan(child, fixture, [...trail, key]);
    }
  }

  for (const { fixture } of loadBindingCorpus()) {
    scan(fixture, fixture);
    assert.deepEqual(fixture.nonClaims, nonClaims);
  }
});

test('original resolver corpus remains unchanged and descriptor-free', () => {
  const before = new Map(expectedResolverFiles.map((file) => [file, fixtureHash(resolverRoot, file)]));
  const fixtures = expectedResolverFiles.map((file) => loadFixture(resolverRoot, file));
  assert.equal(fixtures.length, 12);
  assert.equal(new Set(fixtures.map((fixture) => fixture.caseId)).size, 12);

  function assertNoBindingField(value, label) {
    if (Array.isArray(value)) {
      value.forEach((child) => assertNoBindingField(child, label));
      return;
    }
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.hasOwn(value, 'publicKeySpkiDer'), false, `${label}: no binding field`);
    for (const child of Object.values(value)) assertNoBindingField(child, label);
  }

  fixtures.forEach((fixture) => assertNoBindingField(fixture, fixture.caseId));
  const after = new Map(expectedResolverFiles.map((file) => [file, fixtureHash(resolverRoot, file)]));
  assert.deepEqual(after, before);
});

test('validation is deterministic, file-immutable, and never loads the resolver', () => {
  const resolverModule = require.resolve('../lib/v5/trusted-key-resolver');
  assert.equal(require.cache[resolverModule], undefined);
  const before = new Map(expectedBindingFiles.map((file) => [file, fixtureHash(bindingRoot, file)]));
  const first = loadBindingCorpus();
  const second = loadBindingCorpus();
  assert.deepEqual(second, first);
  for (const { fixture } of first) {
    assert.deepEqual(materializeFixtureInput(fixture.input), materializeFixtureInput(fixture.input));
  }
  const after = new Map(expectedBindingFiles.map((file) => [file, fixtureHash(bindingRoot, file)]));
  assert.deepEqual(after, before);
  assert.equal(require.cache[resolverModule], undefined);
});
