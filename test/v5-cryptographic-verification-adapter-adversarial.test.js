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

function decodeHex(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[0-9a-f]*$/);
  assert.equal(value.length % 2, 0);
  const bytes = Buffer.from(value, 'hex');
  assert.equal(bytes.toString('hex'), value);
  return bytes;
}

function readCorpus() {
  const files = fs.readdirSync(fixtureRoot).filter((file) => file.endsWith('.json')).sort();
  assert.deepEqual(files, expectedCases.map(([file]) => file));
  return files.map((file) => JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8')));
}

function fixtureById(caseId) {
  const fixture = readCorpus().find((item) => item.caseId === caseId);
  assert.ok(fixture, 'missing fixture ' + caseId);
  return fixture;
}

function inputFrom(fixture) {
  const input = {};
  for (const [key, value] of Object.entries(fixture.input)) {
    input[key.endsWith('Hex') ? key.slice(0, -3) : key] = key.endsWith('Hex')
      ? decodeHex(value)
      : value;
  }
  if (Object.hasOwn(fixture, 'unexpected')) {
    input.unexpected = fixture.unexpected;
  }
  return input;
}

function validInput() {
  return inputFrom(fixtureById('valid-rfc8032-one-octet'));
}

function result(state, reasonCategory) {
  return reasonCategory === undefined
    ? { cryptographicState: state }
    : { cryptographicState: state, reasonCategory };
}

function cloneInput(input) {
  return {
    algorithm: input.algorithm,
    messageBytes: Buffer.from(input.messageBytes),
    publicKeySpkiDer: Buffer.from(input.publicKeySpkiDer),
    signatureBytes: Buffer.from(input.signatureBytes)
  };
}

function withVerifyThrow(callback) {
  const verification = mock.method(crypto, 'verify', () => {
    throw new Error('sensitive verify details');
  });
  try {
    return callback(verification);
  } finally {
    mock.restoreAll();
  }
}

test('preserves the complete V22 regression floor and core handoff', () => {
  const corpus = readCorpus();
  assert.equal(corpus.length, 17);
  assert.equal(new Set(corpus.map((item) => item.caseId)).size, 17);

  for (const [, caseId, state, reasonCategory] of expectedCases) {
    const actual = verifyCryptographicEvidence(inputFrom(fixtureById(caseId)));
    assert.deepEqual(actual, result(state, reasonCategory), caseId);
    assert.deepEqual(normalizeCryptographicVerificationEvidence(actual), actual, caseId + ': handoff');
  }
});

test('rejects unsupported root forms and preserves null-prototype behavior', () => {
  const input = validInput();
  for (const value of [
    null, undefined, true, 1, 'input', 1n, Symbol('input'), () => {}, [],
    new Date(), /input/, new Map(), new Set()
  ]) {
    assert.deepEqual(verifyCryptographicEvidence(value), result('malformed', 'input_malformed'));
  }

  const nullPrototype = Object.assign(Object.create(null), input);
  assert.deepEqual(verifyCryptographicEvidence(nullPrototype), result('valid'));
});

test('rejects inherited, unknown, non-enumerable, symbol, and accessor fields without getter execution', () => {
  const input = validInput();

  const inheritedRequired = Object.create({ algorithm: input.algorithm });
  Object.assign(inheritedRequired, {
    messageBytes: input.messageBytes,
    publicKeySpkiDer: input.publicKeySpkiDer,
    signatureBytes: input.signatureBytes
  });
  assert.deepEqual(verifyCryptographicEvidence(inheritedRequired), result('malformed', 'input_malformed'));

  const inheritedUnknown = Object.create({ unexpected: true });
  Object.assign(inheritedUnknown, input);
  assert.deepEqual(verifyCryptographicEvidence(inheritedUnknown), result('malformed', 'input_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, unexpected: true }), result('malformed', 'input_malformed'));

  const nonEnumerable = { ...input };
  Object.defineProperty(nonEnumerable, 'messageBytes', {
    value: input.messageBytes,
    enumerable: false
  });
  assert.deepEqual(verifyCryptographicEvidence(nonEnumerable), result('malformed', 'input_malformed'));

  const nonEnumerableUnknown = { ...input };
  Object.defineProperty(nonEnumerableUnknown, 'unexpected', { value: true });
  assert.deepEqual(verifyCryptographicEvidence(nonEnumerableUnknown), result('malformed', 'input_malformed'));

  assert.deepEqual(
    verifyCryptographicEvidence({ ...input, [Symbol('unexpected')]: true }),
    result('malformed', 'input_malformed')
  );

  for (const key of ['algorithm', 'messageBytes', 'publicKeySpkiDer', 'signatureBytes', 'unexpected']) {
    let called = false;
    const accessorInput = { ...input };
    Object.defineProperty(accessorInput, key, {
      enumerable: true,
      get() {
        called = true;
        throw new Error('getter executed');
      }
    });
    assert.deepEqual(verifyCryptographicEvidence(accessorInput), result('malformed', 'input_malformed'));
    assert.equal(called, false, key);
  }
});

test('preserves exact algorithm policy and never verifies rejected algorithms', () => {
  const rejected = [
    'ED25519-V1', 'Ed25519-v1', ' ed25519-v1', 'ed25519-v1 ',
    'ed25519- v1', 'ed25519\tv1', 'ed25519\nv1', 'ed25519\0v1', '',
    'test-structural-v1', 'ed25519', 'ed25519-v1://provider', 'x'.repeat(4096)
  ];
  withVerifyThrow((verification) => {
    for (const algorithm of rejected) {
      assert.deepEqual(
        verifyCryptographicEvidence({ ...validInput(), algorithm }),
        result('unsupported', 'algorithm_unsupported'),
        algorithm
      );
    }
    for (const algorithm of [null, undefined, 1, {}, []]) {
      assert.deepEqual(
        verifyCryptographicEvidence({ ...validInput(), algorithm }),
        result('malformed', 'input_malformed')
      );
    }
    assert.equal(verification.mock.callCount(), 0);
  });
});

test('confines every byte-bearing field to Buffer and Uint8Array', () => {
  const input = validInput();
  const rejected = [
    new ArrayBuffer(64),
    new DataView(new ArrayBuffer(64)),
    new Uint16Array(32),
    new Uint32Array(16),
    new Int8Array(64),
    [],
    'bytes',
    new String('bytes'),
    { 0: 1, length: 1 },
    { write: () => {} },
    { path: 'memory-key' }
  ];

  for (const value of rejected) {
    assert.deepEqual(verifyCryptographicEvidence({ ...input, messageBytes: value }), result('malformed', 'message_malformed'));
    assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: value }), result('malformed', 'public_key_malformed'));
    assert.deepEqual(verifyCryptographicEvidence({ ...input, signatureBytes: value }), result('malformed', 'signature_malformed'));
  }

  const keyObject = crypto.createPublicKey({
    key: input.publicKeySpkiDer,
    format: 'der',
    type: 'spki'
  });
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: keyObject }), result('malformed', 'public_key_malformed'));
});

test('enforces message bounds using deterministic in-memory values', () => {
  const input = validInput();
  for (const length of [0, 1048577]) {
    assert.deepEqual(
      verifyCryptographicEvidence({ ...input, messageBytes: Buffer.alloc(length) }),
      result('malformed', 'message_malformed'),
      String(length)
    );
  }
  for (const length of [1, 1048575, 1048576]) {
    const actual = verifyCryptographicEvidence({ ...input, messageBytes: Buffer.alloc(length) });
    assert.deepEqual(actual, result('invalid', 'signature_invalid'), String(length));
  }

  const backing = Buffer.alloc(1048577);
  const maximumView = new Uint8Array(backing.buffer, backing.byteOffset, 1048576);
  const overMaximumView = new Uint8Array(backing.buffer, backing.byteOffset, 1048577);
  assert.deepEqual(
    verifyCryptographicEvidence({ ...input, messageBytes: maximumView }),
    result('invalid', 'signature_invalid')
  );
  assert.deepEqual(
    verifyCryptographicEvidence({ ...input, messageBytes: overMaximumView }),
    result('malformed', 'message_malformed')
  );
});

test('rejects malformed and non-Ed25519 public keys before crypto.verify', () => {
  const input = validInput();
  const mutations = [
    ['tag', 0, 0x31],
    ['length', 1, 0x29],
    ['oid', 8, 0x66],
    ['bit-string', 10, 0x04]
  ];
  for (const [label, index, value] of mutations) {
    const key = Buffer.from(input.publicKeySpkiDer);
    key[index] = value;
    withVerifyThrow((verification) => {
      assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: key }), result('malformed', 'public_key_malformed'), label);
      assert.equal(verification.mock.callCount(), 0, label);
    });
  }

  const { publicKey: rsaPublicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const rsaDer = rsaPublicKey.export({ format: 'der', type: 'spki' });
  withVerifyThrow((verification) => {
    assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: rsaDer }), result('malformed', 'public_key_malformed'));
    assert.equal(verification.mock.callCount(), 0);
  });

  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: privateDer }), result('malformed', 'public_key_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: '-----BEGIN PUBLIC KEY-----' }), result('malformed', 'public_key_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: { kty: 'OKP', crv: 'Ed25519' } }), result('malformed', 'public_key_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: Buffer.alloc(32) }), result('malformed', 'public_key_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: { provider: 'key-store' } }), result('malformed', 'public_key_malformed'));
});

test('separates signature type/length failures from exact-length invalid signatures', () => {
  const input = validInput();
  for (const signatureBytes of [
    Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(63), Buffer.alloc(65), Buffer.alloc(1024),
    'hex', 'base64', new ArrayBuffer(64), new DataView(new ArrayBuffer(64))
  ]) {
    assert.deepEqual(verifyCryptographicEvidence({ ...input, signatureBytes }), result('malformed', 'signature_malformed'));
  }
  assert.deepEqual(verifyCryptographicEvidence({ ...input, signatureBytes: Buffer.alloc(64) }), result('invalid', 'signature_invalid'));
  const mutated = Buffer.from(input.signatureBytes);
  mutated[0] ^= 0xff;
  assert.deepEqual(verifyCryptographicEvidence({ ...input, signatureBytes: mutated }), result('invalid', 'signature_invalid'));
});

test('respects offset, sliced, subarray, and overlapping byte views', () => {
  const input = validInput();
  const messageBacking = Buffer.concat([Buffer.from([1, 2]), input.messageBytes, Buffer.from([3, 4])]);
  const keyBacking = Buffer.concat([Buffer.from([5, 6]), input.publicKeySpkiDer, Buffer.from([7, 8])]);
  const signatureBacking = Buffer.concat([Buffer.from([9, 10]), input.signatureBytes, Buffer.from([11, 12])]);
  const message = new Uint8Array(messageBacking.buffer, messageBacking.byteOffset + 2, input.messageBytes.length);
  const key = new Uint8Array(keyBacking.buffer, keyBacking.byteOffset + 2, input.publicKeySpkiDer.length);
  const signature = new Uint8Array(signatureBacking.buffer, signatureBacking.byteOffset + 2, input.signatureBytes.length);
  const snapshots = [Buffer.from(messageBacking), Buffer.from(keyBacking), Buffer.from(signatureBacking)];

  assert.deepEqual(verifyCryptographicEvidence({
    algorithm: input.algorithm,
    messageBytes: message,
    publicKeySpkiDer: key,
    signatureBytes: signature
  }), result('valid'));
  assert.deepEqual(Buffer.from(messageBacking), snapshots[0]);
  assert.deepEqual(Buffer.from(keyBacking), snapshots[1]);
  assert.deepEqual(Buffer.from(signatureBacking), snapshots[2]);

  const shared = Buffer.concat([input.messageBytes, input.signatureBytes]);
  const overlapMessage = shared.subarray(0, input.messageBytes.length);
  const overlapSignature = Buffer.concat([input.signatureBytes]);
  assert.deepEqual(verifyCryptographicEvidence({
    algorithm: input.algorithm,
    messageBytes: overlapMessage,
    publicKeySpkiDer: input.publicKeySpkiDer.subarray(0),
    signatureBytes: overlapSignature
  }), result('valid'));
});

test('contains import and verify exceptions with exact bounded results', () => {
  const input = validInput();
  const createKey = mock.method(crypto, 'createPublicKey', () => {
    throw new Error('private OpenSSL import details');
  });
  try {
    const actual = verifyCryptographicEvidence(input);
    assert.deepEqual(actual, result('malformed', 'public_key_malformed'));
    assert.deepEqual(Object.keys(actual).sort(), ['cryptographicState', 'reasonCategory']);
    assert.equal(createKey.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }

  const before = cloneInput(input);
  withVerifyThrow((verification) => {
    const actual = verifyCryptographicEvidence(input);
    assert.deepEqual(actual, result('malformed', 'input_malformed'));
    assert.deepEqual(Object.keys(actual).sort(), ['cryptographicState', 'reasonCategory']);
    assert.equal(verification.mock.callCount(), 1);
  });
  assert.deepEqual(input.messageBytes, before.messageBytes);
  assert.deepEqual(input.publicKeySpkiDer, before.publicKeySpkiDer);
  assert.deepEqual(input.signatureBytes, before.signatureBytes);
});

test('preserves validation precedence across compound-invalid inputs', () => {
  const input = validInput();
  assert.deepEqual(verifyCryptographicEvidence({ ...input, algorithm: 'ed25519-v2', unexpected: true }), result('malformed', 'input_malformed'));

  const missing = { ...input, messageBytes: 'not-bytes' };
  delete missing.signatureBytes;
  assert.deepEqual(verifyCryptographicEvidence(missing), result('malformed', 'input_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, algorithm: 'ed25519-v2', messageBytes: Buffer.alloc(0) }), result('unsupported', 'algorithm_unsupported'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, messageBytes: Buffer.alloc(0), publicKeySpkiDer: Buffer.alloc(43) }), result('malformed', 'message_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, publicKeySpkiDer: Buffer.alloc(43), signatureBytes: Buffer.alloc(63) }), result('malformed', 'public_key_malformed'));
  assert.deepEqual(verifyCryptographicEvidence({ ...input, signatureBytes: Buffer.alloc(63) }), result('malformed', 'signature_malformed'));
  withVerifyThrow(() => {
    assert.deepEqual(verifyCryptographicEvidence(input), result('malformed', 'input_malformed'));
  });
});

test('keeps frozen and sealed roots immutable and returns fresh outputs', () => {
  const frozen = validInput();
  Object.freeze(frozen);
  const sealed = validInput();
  Object.seal(sealed);
  assert.deepEqual(verifyCryptographicEvidence(frozen), result('valid'));
  assert.deepEqual(verifyCryptographicEvidence(sealed), result('valid'));

  const first = verifyCryptographicEvidence(validInput());
  first.cryptographicState = 'invalid';
  const second = verifyCryptographicEvidence(validInput());
  assert.deepEqual(second, result('valid'));
  assert.notStrictEqual(first, second);
});

test('is deterministic and has no adapter-owned external side effects', () => {
  const input = validInput();
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'v5', 'cryptographic-verification-adapter.js'), 'utf8');
  assert.equal(source.includes("require('node:fs')"), false);
  assert.equal(source.includes("require('node:http')"), false);
  assert.equal(source.includes('fetch('), false);

  const oldDateNow = Date.now;
  const oldRandom = Math.random;
  const oldFetch = globalThis.fetch;
  Date.now = () => { throw new Error('clock forbidden'); };
  Math.random = () => { throw new Error('randomness forbidden'); };
  globalThis.fetch = () => { throw new Error('network forbidden'); };
  try {
    const results = [
      verifyCryptographicEvidence(input),
      verifyCryptographicEvidence(input),
      verifyCryptographicEvidence({ ...input })
    ];
    assert.deepEqual(results[0], result('valid'));
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
  } finally {
    Date.now = oldDateNow;
    Math.random = oldRandom;
    globalThis.fetch = oldFetch;
  }
});
