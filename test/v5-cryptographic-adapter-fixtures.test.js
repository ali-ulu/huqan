'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'cryptographic-adapter');
const standardRootKeys = ['caseId', 'description', 'expected', 'input', 'nonClaims'];
const standardInputKeys = [
  'algorithm',
  'messageBytesHex',
  'publicKeySpkiDerHex',
  'signatureBytesHex'
];
const nonClaims = [
  'package_trust_not_established',
  'action_authorization_not_established',
  'identity_verification_not_established',
  'external_exchange_not_established',
  'production_crypto_not_claimed'
];
const expectedCases = [
  ['01-valid-rfc8032-one-octet.json', 'valid-rfc8032-one-octet', 'valid', undefined],
  ['02-invalid-message-byte-mutation.json', 'invalid-message-byte-mutation', 'invalid', 'signature_invalid'],
  ['03-invalid-signature-byte-mutation.json', 'invalid-signature-byte-mutation', 'invalid', 'signature_invalid'],
  ['04-invalid-different-ed25519-public-key.json', 'invalid-different-ed25519-public-key', 'invalid', 'signature_invalid'],
  ['05-unsupported-algorithm.json', 'unsupported-algorithm', 'unsupported', 'algorithm_unsupported'],
  ['06-unsupported-algorithm-case-variant.json', 'unsupported-algorithm-case-variant', 'unsupported', 'algorithm_unsupported'],
  ['07-malformed-empty-message.json', 'malformed-empty-message', 'malformed', 'message_malformed'],
  ['08-malformed-public-key-one-byte-short.json', 'malformed-public-key-one-byte-short', 'malformed', 'public_key_malformed'],
  ['09-malformed-public-key-one-byte-long.json', 'malformed-public-key-one-byte-long', 'malformed', 'public_key_malformed'],
  ['10-malformed-public-key-invalid-spki.json', 'malformed-public-key-invalid-spki', 'malformed', 'public_key_malformed'],
  ['11-malformed-signature-one-byte-short.json', 'malformed-signature-one-byte-short', 'malformed', 'signature_malformed'],
  ['12-malformed-signature-one-byte-long.json', 'malformed-signature-one-byte-long', 'malformed', 'signature_malformed'],
  ['13-malformed-empty-signature.json', 'malformed-empty-signature', 'malformed', 'signature_malformed'],
  ['14-invalid-wrong-64-byte-signature.json', 'invalid-wrong-64-byte-signature', 'invalid', 'signature_invalid'],
  ['15-malformed-missing-signature-field.json', 'malformed-missing-signature-field', 'malformed', 'input_malformed'],
  ['16-malformed-unknown-root-field.json', 'malformed-unknown-root-field', 'malformed', 'input_malformed'],
  ['17-malformed-forbidden-input-material.json', 'malformed-forbidden-input-material', 'malformed', 'input_malformed']
];
const allowedReasons = new Map([
  ['valid', new Set([undefined])],
  ['invalid', new Set(['signature_invalid'])],
  ['malformed', new Set([
    'input_malformed',
    'message_malformed',
    'public_key_malformed',
    'signature_malformed'
  ])],
  ['unsupported', new Set(['algorithm_unsupported'])]
]);
const hexPattern = /^[0-9a-f]*$/;

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function readCorpus() {
  const entries = fs.readdirSync(fixtureRoot).sort();
  const expectedFiles = expectedCases.map(([file]) => file);
  assert.deepEqual(entries, expectedFiles);
  return entries.map((file) => ({
    file,
    fixture: JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'))
  }));
}

function byCaseId(corpus, caseId) {
  const item = corpus.find(({ fixture }) => fixture.caseId === caseId);
  assert.ok(item, 'missing fixture: ' + caseId);
  return item.fixture;
}

function decodeHex(value, label) {
  assert.equal(typeof value, 'string', label + ': string');
  assert.equal(hexPattern.test(value), true, label + ': lowercase hexadecimal');
  assert.equal(value.length % 2, 0, label + ': even length');
  const bytes = Buffer.from(value, 'hex');
  assert.equal(bytes.toString('hex'), value, label + ': strict round-trip');
  return bytes;
}

function assertExpected(expected, state, reason, label) {
  const expectedKeys = reason === undefined
    ? ['cryptographicState']
    : ['cryptographicState', 'reasonCategory'];
  assert.deepEqual(sortedKeys(expected), expectedKeys, label + ': expected keys');
  assert.equal(expected.cryptographicState, state, label + ': state');
  assert.equal(expected.reasonCategory, reason, label + ': reason');
  assert.equal(allowedReasons.get(state).has(reason), true, label + ': vocabulary');
}

function assertInputShape(fixture) {
  const keys = sortedKeys(fixture.input);
  const id = fixture.caseId;
  if (id === 'malformed-missing-signature-field') {
    assert.deepEqual(keys, [
      'algorithm',
      'messageBytesHex',
      'publicKeySpkiDerHex'
    ]);
    return;
  }
  if (id === 'malformed-forbidden-input-material') {
    assert.deepEqual(keys, [...standardInputKeys, 'privateKeyHex'].sort());
    assert.equal(fixture.input.privateKeyHex, '00');
    return;
  }
  assert.deepEqual(keys, standardInputKeys);
}

function assertRootShape(fixture) {
  const id = fixture.caseId;
  const expected = id === 'valid-rfc8032-one-octet'
    ? [...standardRootKeys, 'provenance'].sort()
    : id === 'malformed-unknown-root-field'
      ? [...standardRootKeys, 'unexpected'].sort()
      : standardRootKeys;
  assert.deepEqual(sortedKeys(fixture), expected, id + ': root keys');
  if (id === 'malformed-unknown-root-field') {
    assert.equal(fixture.unexpected, 'fixture-envelope-confinement');
  }
}

function assertNoSecretMaterial(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, [...pathParts, String(index)]));
    return;
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      for (const marker of ['-----BEGIN', 'credential', 'token', 'password', 'http://', 'https://']) {
        assert.equal(value.toLowerCase().includes(marker.toLowerCase()), false, pathParts.join('.') + ': ' + marker);
      }
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const location = [...pathParts, key];
    const lower = key.toLowerCase();
    const allowedPlaceholder = pathParts.join('.') === 'input' &&
      key === 'privateKeyHex' &&
      nested === '00';
    if (!allowedPlaceholder) {
      for (const forbidden of ['privatekey', 'private_key', 'seed', 'secret', 'credential', 'token', 'password', 'endpoint', 'provider', 'keystore', 'database']) {
        assert.equal(lower.includes(forbidden), false, location.join('.') + ': forbidden key');
      }
    }
    assertNoSecretMaterial(nested, location);
  }
}

test('cryptographic adapter fixture corpus has the exact deterministic 17-file inventory', () => {
  const first = readCorpus();
  const second = readCorpus();

  assert.equal(first.length, 17);
  assert.equal(new Set(first.map(({ file }) => file)).size, 17);
  assert.deepEqual(
    first.map(({ fixture }) => fixture.caseId),
    expectedCases.map(([, caseId]) => caseId)
  );
  assert.deepEqual(second.map(({ fixture }) => fixture), first.map(({ fixture }) => fixture));
});

test('cryptographic adapter fixture envelope, input confinement, and expected vocabulary are exact', () => {
  const corpus = readCorpus();

  for (const { file, fixture } of corpus) {
    const [, caseId, state, reason] = expectedCases.find(([name]) => name === file);
    assert.equal(fixture.caseId, caseId);
    assert.equal(typeof fixture.description, 'string');
    assert.notEqual(fixture.description.trim(), '');
    assertRootShape(fixture);
    assertInputShape(fixture);
    assertExpected(fixture.expected, state, reason, caseId);
    assert.deepEqual(fixture.nonClaims, nonClaims, caseId + ': nonClaims');

    for (const [key, value] of Object.entries(fixture.input)) {
      if (key.endsWith('Hex')) {
        decodeHex(value, caseId + ': ' + key);
      }
    }
  }
});

test('authoritative RFC 8032 TEST 2 provenance and SPKI DER shape are locked', () => {
  const valid = byCaseId(readCorpus(), 'valid-rfc8032-one-octet');

  assert.deepEqual(sortedKeys(valid.provenance), [
    'publicKeySpkiDerTransformation',
    'sourceMessageBytesHex',
    'sourcePublicKeyHex',
    'sourceSection',
    'sourceSignatureHex',
    'sourceTitle',
    'vectorId'
  ]);
  assert.equal(valid.provenance.sourceTitle, 'RFC 8032: Edwards-Curve Digital Signature Algorithm (EdDSA)');
  assert.equal(valid.provenance.sourceSection, '7.1 Test Vectors for Ed25519');
  assert.equal(valid.provenance.vectorId, 'TEST 2');
  assert.equal(valid.provenance.sourceMessageBytesHex, '72');
  assert.equal(valid.provenance.sourcePublicKeyHex.endsWith('f4660c'), true);
  assert.equal(valid.provenance.sourceSignatureHex, valid.input.signatureBytesHex);
  assert.equal(
    valid.provenance.publicKeySpkiDerTransformation,
    '302a300506032b6570032100 + sourcePublicKeyHex'
  );

  const key = decodeHex(valid.input.publicKeySpkiDerHex, 'valid key');
  const rawPublicKey = decodeHex(valid.provenance.sourcePublicKeyHex, 'source public key');
  assert.equal(rawPublicKey.length, 32);
  assert.equal(key.length, 44);
  assert.deepEqual(key.subarray(0, 12).toString('hex'), '302a300506032b6570032100');
  assert.deepEqual(key.subarray(12), rawPublicKey);
});

test('fixture byte boundaries distinguish valid, malformed, and unsupported classes', () => {
  const corpus = readCorpus();
  const validShapeCases = [
    'valid-rfc8032-one-octet',
    'invalid-message-byte-mutation',
    'invalid-signature-byte-mutation',
    'invalid-different-ed25519-public-key',
    'invalid-wrong-64-byte-signature'
  ];

  for (const caseId of validShapeCases) {
    const input = byCaseId(corpus, caseId).input;
    assert.equal(decodeHex(input.messageBytesHex, caseId + ': message').length > 0, true);
    assert.equal(decodeHex(input.publicKeySpkiDerHex, caseId + ': public key').length, 44);
    assert.equal(decodeHex(input.signatureBytesHex, caseId + ': signature').length, 64);
  }

  assert.equal(decodeHex(byCaseId(corpus, 'malformed-empty-message').input.messageBytesHex, 'empty message').length, 0);
  assert.equal(decodeHex(byCaseId(corpus, 'malformed-public-key-one-byte-short').input.publicKeySpkiDerHex, 'short key').length, 43);
  assert.equal(decodeHex(byCaseId(corpus, 'malformed-public-key-one-byte-long').input.publicKeySpkiDerHex, 'long key').length, 45);
  assert.equal(decodeHex(byCaseId(corpus, 'malformed-public-key-invalid-spki').input.publicKeySpkiDerHex, 'invalid DER key').length, 44);
  assert.equal(decodeHex(byCaseId(corpus, 'malformed-signature-one-byte-short').input.signatureBytesHex, 'short signature').length, 63);
  assert.equal(decodeHex(byCaseId(corpus, 'malformed-signature-one-byte-long').input.signatureBytesHex, 'long signature').length, 65);
  assert.equal(decodeHex(byCaseId(corpus, 'malformed-empty-signature').input.signatureBytesHex, 'empty signature').length, 0);
  assert.equal(byCaseId(corpus, 'unsupported-algorithm').input.algorithm, 'ed25519-v2');
  assert.equal(byCaseId(corpus, 'unsupported-algorithm-case-variant').input.algorithm, 'Ed25519-v1');
});

test('fixture mutations are exact, reproducible, and preserve their intended classification', () => {
  const corpus = readCorpus();
  const valid = byCaseId(corpus, 'valid-rfc8032-one-octet');
  const mutations = [
    ['invalid-message-byte-mutation', 'messageBytesHex', 0, 0x72, 0x73, 'invalid', 'signature_invalid', 'Parent valid-rfc8032-one-octet; message byte index 0 changes from 72 to 73.'],
    ['invalid-signature-byte-mutation', 'signatureBytesHex', 0, 0x92, 0x93, 'invalid', 'signature_invalid', 'Parent valid-rfc8032-one-octet; signature byte index 0 changes from 92 to 93.'],
    ['malformed-public-key-one-byte-short', 'publicKeySpkiDerHex', 43, 0x0c, null, 'malformed', 'public_key_malformed', 'Parent valid-rfc8032-one-octet; publicKeySpkiDerHex byte index 43 value 0c is removed.'],
    ['malformed-public-key-one-byte-long', 'publicKeySpkiDerHex', 44, null, 0x00, 'malformed', 'public_key_malformed', 'Parent valid-rfc8032-one-octet; publicKeySpkiDerHex gains byte index 44 value 00 after length 44.'],
    ['malformed-public-key-invalid-spki', 'publicKeySpkiDerHex', 0, 0x30, 0x31, 'malformed', 'public_key_malformed', 'Parent valid-rfc8032-one-octet; SPKI DER byte index 0 changes from 30 to 31 while length remains 44.'],
    ['malformed-signature-one-byte-short', 'signatureBytesHex', 63, 0x00, null, 'malformed', 'signature_malformed', 'Parent valid-rfc8032-one-octet; signatureBytesHex byte index 63 value 00 is removed.'],
    ['malformed-signature-one-byte-long', 'signatureBytesHex', 64, null, 0x00, 'malformed', 'signature_malformed', 'Parent valid-rfc8032-one-octet; signatureBytesHex gains byte index 64 value 00 after length 64.'],
    ['invalid-wrong-64-byte-signature', 'signatureBytesHex', 63, 0x00, 0x01, 'invalid', 'signature_invalid', 'Parent valid-rfc8032-one-octet; signature byte index 63 changes from 00 to 01.']
  ];

  for (const [caseId, field, index, original, replacement, state, reason, description] of mutations) {
    const fixture = byCaseId(corpus, caseId);
    const parent = decodeHex(valid.input[field], caseId + ': parent');
    const child = decodeHex(fixture.input[field], caseId + ': child');

    if (original !== null) assert.equal(parent[index], original, caseId + ': original byte');
    if (replacement !== null) assert.equal(child[index], replacement, caseId + ': replacement byte');
    if (replacement === null) assert.equal(child.length, parent.length - 1, caseId + ': removal length');
    if (original === null) assert.equal(child.length, parent.length + 1, caseId + ': append length');
    assert.equal(fixture.description, description, caseId + ': mutation description');
    assertExpected(fixture.expected, state, reason, caseId);
  }
});

test('RFC 8032 known-answer vector verifies and four structurally valid negative cases fail', () => {
  const corpus = readCorpus();
  const valid = byCaseId(corpus, 'valid-rfc8032-one-octet');
  const validKey = crypto.createPublicKey({
    key: decodeHex(valid.input.publicKeySpkiDerHex, 'valid key'),
    format: 'der',
    type: 'spki'
  });

  assert.equal(validKey.asymmetricKeyType, 'ed25519');
  assert.equal(
    crypto.verify(
      null,
      decodeHex(valid.input.messageBytesHex, 'valid message'),
      validKey,
      decodeHex(valid.input.signatureBytesHex, 'valid signature')
    ),
    true
  );

  for (const caseId of [
    'invalid-message-byte-mutation',
    'invalid-signature-byte-mutation',
    'invalid-different-ed25519-public-key',
    'invalid-wrong-64-byte-signature'
  ]) {
    const fixture = byCaseId(corpus, caseId);
    const key = crypto.createPublicKey({
      key: decodeHex(fixture.input.publicKeySpkiDerHex, caseId + ': key'),
      format: 'der',
      type: 'spki'
    });
    assert.equal(
      crypto.verify(
        null,
        decodeHex(fixture.input.messageBytesHex, caseId + ': message'),
        key,
        decodeHex(fixture.input.signatureBytesHex, caseId + ': signature')
      ),
      false,
      caseId
    );
  }

  const shortKey = byCaseId(corpus, 'malformed-public-key-one-byte-short');
  assert.equal(
    decodeHex(shortKey.input.publicKeySpkiDerHex, 'case 08 key').length,
    43
  );
  assert.equal(
    decodeHex(valid.input.publicKeySpkiDerHex, 'parent key')[43],
    0x0c
  );
  assert.throws(() => crypto.createPublicKey({
    key: decodeHex(shortKey.input.publicKeySpkiDerHex, 'case 08 key'),
    format: 'der',
    type: 'spki'
  }));
});

test('fixtures preserve nonClaims, contain no secret material, and remain immutable', () => {
  const corpus = readCorpus();
  const before = JSON.parse(JSON.stringify(corpus));

  for (const { fixture } of corpus) {
    assertNoSecretMaterial(fixture);
    assert.deepEqual(fixture.nonClaims, nonClaims);
  }

  const privatePlaceholder = byCaseId(corpus, 'malformed-forbidden-input-material');
  assert.equal(privatePlaceholder.input.privateKeyHex, '00');
  assert.equal(Object.hasOwn(privatePlaceholder.input, 'provider'), false);
  assert.deepEqual(corpus, before);
});

test('fixture contract test is deterministic and has no clock, randomness, or network branch', () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  const originalRandom = Math.random;
  globalThis.fetch = () => {
    throw new Error('network access is forbidden');
  };
  Date.now = () => {
    throw new Error('system clock access is forbidden');
  };
  Math.random = () => {
    throw new Error('randomness is forbidden');
  };

  try {
    const first = readCorpus().map(({ fixture }) => JSON.stringify(fixture));
    const second = readCorpus().map(({ fixture }) => JSON.stringify(fixture));
    assert.deepEqual(first, second);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    Math.random = originalRandom;
  }
});
