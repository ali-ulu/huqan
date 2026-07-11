'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mock } = require('node:test');

const {
  verifyCryptographicEvidence
} = require('../lib/v5/cryptographic-verification-adapter');
const {
  normalizeCryptographicVerificationEvidence
} = require('../lib/v5/verification-core');

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'cryptographic-adapter');
const expectedCases = [
  ['01-valid-rfc8032-one-octet.json', 'valid-rfc8032-one-octet', 'valid'],
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
const hexPattern = /^[0-9a-f]*$/;

function decodeHex(value, label) {
  assert.equal(typeof value, 'string', label + ': string');
  assert.equal(hexPattern.test(value), true, label + ': lowercase hexadecimal');
  assert.equal(value.length % 2, 0, label + ': even length');
  const bytes = Buffer.from(value, 'hex');
  assert.equal(bytes.toString('hex'), value, label + ': strict round-trip');
  return bytes;
}

function readCorpus() {
  const entries = fs.readdirSync(fixtureRoot).filter((file) => file.endsWith('.json')).sort();
  assert.deepEqual(entries, expectedCases.map(([file]) => file));
  return entries.map((file) => ({
    file,
    fixture: JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'))
  }));
}

function buildInput(fixture) {
  const input = {};
  for (const [key, value] of Object.entries(fixture.input)) {
    if (key.endsWith('Hex')) {
      input[key.slice(0, -3)] = decodeHex(value, fixture.caseId + ': ' + key);
    } else {
      input[key] = value;
    }
  }
  if (Object.hasOwn(fixture, 'unexpected')) {
    input.unexpected = fixture.unexpected;
  }
  return input;
}

function expectedResult(state, reason) {
  return reason === undefined
    ? { cryptographicState: state }
    : { cryptographicState: state, reasonCategory: reason };
}

function byCaseId(corpus, caseId) {
  const entry = corpus.find(({ fixture }) => fixture.caseId === caseId);
  assert.ok(entry, 'missing fixture: ' + caseId);
  return entry.fixture;
}

test('exports exactly one synchronous named API', () => {
  const moduleExports = require('../lib/v5/cryptographic-verification-adapter');
  assert.deepEqual(Object.keys(moduleExports), ['verifyCryptographicEvidence']);
  assert.equal(typeof verifyCryptographicEvidence, 'function');
  assert.equal(verifyCryptographicEvidence.constructor.name, 'Function');
});

test('consumes every fixture exactly once and preserves the expected mapping', () => {
  const corpus = readCorpus();
  assert.equal(corpus.length, 17);
  assert.equal(new Set(corpus.map(({ fixture }) => fixture.caseId)).size, 17);

  for (const [file, caseId, state, reason] of expectedCases) {
    const fixture = corpus.find((entry) => entry.file === file).fixture;
    assert.equal(fixture.caseId, caseId);
    const result = verifyCryptographicEvidence(buildInput(fixture));
    assert.deepEqual(result, expectedResult(state, reason), caseId);
    assert.deepEqual(normalizeCryptographicVerificationEvidence(result), result, caseId + ': core handoff');
  }
});

test('verifies RFC 8032 TEST 2 and four structurally valid negative vectors', () => {
  const corpus = readCorpus();
  const valid = byCaseId(corpus, 'valid-rfc8032-one-octet');
  const validInput = buildInput(valid);
  assert.deepEqual(verifyCryptographicEvidence(validInput), { cryptographicState: 'valid' });

  for (const caseId of [
    'invalid-message-byte-mutation',
    'invalid-signature-byte-mutation',
    'invalid-different-ed25519-public-key',
    'invalid-wrong-64-byte-signature'
  ]) {
    assert.deepEqual(
      verifyCryptographicEvidence(buildInput(byCaseId(corpus, caseId))),
      { cryptographicState: 'invalid', reasonCategory: 'signature_invalid' },
      caseId
    );
  }
});

test('rejects roots, fields, accessors, and inheritance without executing getters', () => {
  const corpus = readCorpus();
  const input = buildInput(byCaseId(corpus, 'valid-rfc8032-one-octet'));
  for (const value of [null, undefined, 1, 'input', [], new Date(), /input/]) {
    assert.deepEqual(verifyCryptographicEvidence(value), {
      cryptographicState: 'malformed', reasonCategory: 'input_malformed'
    });
  }

  assert.deepEqual(verifyCryptographicEvidence({ ...input, extra: true }), {
    cryptographicState: 'malformed', reasonCategory: 'input_malformed'
  });
  const missing = { ...input };
  delete missing.signatureBytes;
  assert.deepEqual(verifyCryptographicEvidence(missing), {
    cryptographicState: 'malformed', reasonCategory: 'input_malformed'
  });

  let called = false;
  const withGetter = { ...input };
  Object.defineProperty(withGetter, 'messageBytes', {
    enumerable: true,
    get() {
      called = true;
      return input.messageBytes;
    }
  });
  assert.deepEqual(verifyCryptographicEvidence(withGetter), {
    cryptographicState: 'malformed', reasonCategory: 'input_malformed'
  });
  assert.equal(called, false);

  const inherited = Object.create({ extra: true });
  Object.assign(inherited, input);
  assert.deepEqual(verifyCryptographicEvidence(inherited), {
    cryptographicState: 'malformed', reasonCategory: 'input_malformed'
  });
  const symbolInput = { ...input, [Symbol('extra')]: true };
  assert.deepEqual(verifyCryptographicEvidence(symbolInput), {
    cryptographicState: 'malformed', reasonCategory: 'input_malformed'
  });
});

test('enforces exact algorithm, message, key, and signature boundaries', () => {
  const corpus = readCorpus();
  const input = buildInput(byCaseId(corpus, 'valid-rfc8032-one-octet'));
  const malformed = (reasonCategory) => ({ cryptographicState: 'malformed', reasonCategory });

  assert.deepEqual(verifyCryptographicEvidence({ ...input, algorithm: 1 }), malformed('input_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, algorithm: 'Ed25519-v1' }), {
    cryptographicState: 'unsupported', reasonCategory: 'algorithm_unsupported'
  });
  assert.deepEqual(verifyCryptographicEvidence({ ...input, algorithm: 'ed25519-v1 ' }), {
    cryptographicState: 'unsupported', reasonCategory: 'algorithm_unsupported'
  });
  assert.deepEqual(verifyCryptographicEvidence({ ...input, messageBytes: Buffer.alloc(0) }), malformed('message_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, messageBytes: '72' }), malformed('message_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, messageBytes: Buffer.alloc(1048577) }), malformed('message_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: Buffer.alloc(43) }), malformed('public_key_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: Buffer.alloc(45) }), malformed('public_key_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: 'key' }), malformed('public_key_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, signatureBytes: Buffer.alloc(63) }), malformed('signature_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, signatureBytes: Buffer.alloc(65) }), malformed('signature_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, signatureBytes: '' }), malformed('signature_malformed'));
});

test('case 08 rejects the short public key before crypto.verify', () => {
  const corpus = readCorpus();
  const valid = byCaseId(corpus, 'valid-rfc8032-one-octet');
  const shortKey = byCaseId(corpus, 'malformed-public-key-one-byte-short');
  assert.equal(buildInput(valid).publicKeySpkiDer[43], 0x0c);
  assert.equal(buildInput(shortKey).publicKeySpkiDer.length, 43);
  const verify = mock.method(crypto, 'verify', () => {
    throw new Error('crypto.verify must not run');
  });
  try {
    assert.deepEqual(verifyCryptographicEvidence(buildInput(shortKey)), {
      cryptographicState: 'malformed', reasonCategory: 'public_key_malformed'
    });
    assert.equal(verify.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
  }
});

test('accepts Buffer and offset Uint8Array views without mutation', () => {
  const corpus = readCorpus();
  const valid = buildInput(byCaseId(corpus, 'valid-rfc8032-one-octet'));
  const messageBacking = Buffer.concat([Buffer.from([0xaa]), valid.messageBytes, Buffer.from([0xbb])]);
  const keyBacking = Buffer.concat([Buffer.from([0xaa]), valid.publicKeySpkiDer, Buffer.from([0xbb])]);
  const signatureBacking = Buffer.concat([Buffer.from([0xaa]), valid.signatureBytes, Buffer.from([0xbb])]);
  const message = new Uint8Array(messageBacking.buffer, messageBacking.byteOffset + 1, valid.messageBytes.length);
  const key = new Uint8Array(keyBacking.buffer, keyBacking.byteOffset + 1, valid.publicKeySpkiDer.length);
  const signature = new Uint8Array(signatureBacking.buffer, signatureBacking.byteOffset + 1, valid.signatureBytes.length);
  const before = {
    message: Buffer.from(message),
    key: Buffer.from(key),
    signature: Buffer.from(signature)
  };
  assert.deepEqual(verifyCryptographicEvidence({
    algorithm: valid.algorithm,
    messageBytes: message,
    publicKeySpkiDer: key,
    signatureBytes: signature
  }), { cryptographicState: 'valid' });
  assert.deepEqual(Buffer.from(message), before.message);
  assert.deepEqual(Buffer.from(key), before.key);
  assert.deepEqual(Buffer.from(signature), before.signature);
});

test('maps post-validation crypto.verify exceptions without leaking details', () => {
  const corpus = readCorpus();
  const input = buildInput(byCaseId(corpus, 'valid-rfc8032-one-octet'));
  const verify = mock.method(crypto, 'verify', () => {
    throw new Error('secret OpenSSL exception details');
  });
  try {
    assert.deepEqual(verifyCryptographicEvidence(input), {
      cryptographicState: 'malformed', reasonCategory: 'input_malformed'
    });
    assert.equal(verify.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }
});

test('is deterministic, immutable, and independent of clock/random/network', () => {
  const corpus = readCorpus();
  const fixture = byCaseId(corpus, 'valid-rfc8032-one-octet');
  const input = buildInput(fixture);
  const before = {
    algorithm: input.algorithm,
    messageBytes: Buffer.from(input.messageBytes),
    publicKeySpkiDer: Buffer.from(input.publicKeySpkiDer),
    signatureBytes: Buffer.from(input.signatureBytes)
  };
  const oldDateNow = Date.now;
  const oldRandom = Math.random;
  const oldFetch = globalThis.fetch;
  Date.now = () => { throw new Error('clock forbidden'); };
  Math.random = () => { throw new Error('randomness forbidden'); };
  globalThis.fetch = () => { throw new Error('network forbidden'); };
  try {
    const first = verifyCryptographicEvidence(input);
    const second = verifyCryptographicEvidence(input);
    assert.deepEqual(first, { cryptographicState: 'valid' });
    assert.deepEqual(second, first);
  } finally {
    Date.now = oldDateNow;
    Math.random = oldRandom;
    globalThis.fetch = oldFetch;
  }
  assert.equal(input.algorithm, before.algorithm);
  assert.deepEqual(input.messageBytes, before.messageBytes);
  assert.deepEqual(input.publicKeySpkiDer, before.publicKeySpkiDer);
  assert.deepEqual(input.signatureBytes, before.signatureBytes);
});

test('supports frozen and sealed inputs and keeps output bounded', () => {
  const corpus = readCorpus();
  const input = buildInput(byCaseId(corpus, 'valid-rfc8032-one-octet'));
  Object.freeze(input);
  const result = verifyCryptographicEvidence(input);
  assert.deepEqual(result, { cryptographicState: 'valid' });
  assert.deepEqual(Object.keys(result), ['cryptographicState']);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, 'reasonCategory'), false);
});
