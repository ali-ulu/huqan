'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateBoundedVerification,
  normalizeCryptographicVerificationEvidence
} = require('../lib/v5/verification-core');

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'verification');

function readFixtures() {
  return fs
    .readdirSync(fixtureRoot)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8')));
}

function fixtureInput(fixture) {
  return fixture.caseId === 'deterministic-repeat'
    ? fixture.input.equivalentInputs[0]
    : fixture.input;
}

test('bounded verification core matches all 15 fixture expectations', () => {
  const fixtures = readFixtures();
  assert.equal(fixtures.length, 15);

  for (const fixture of fixtures) {
    const actual = evaluateBoundedVerification(fixtureInput(fixture));
    assert.deepEqual(actual, fixture.expected, fixture.caseId);
    assert.deepEqual(Object.keys(actual).sort(), ['reasonCategory', 'verificationStatus']);
  }
});

test('bounded verification core is deterministic and does not mutate input', () => {
  for (const fixture of readFixtures()) {
    const input = fixtureInput(fixture);
    const before = JSON.parse(JSON.stringify(input));
    const first = evaluateBoundedVerification(input);
    const second = evaluateBoundedVerification(input);

    assert.deepEqual(second, first, fixture.caseId);
    assert.deepEqual(input, before, fixture.caseId);
    assert.doesNotThrow(() => JSON.stringify(first));
  }
});

test('deterministic repeat fixture produces equal bounded results', () => {
  const fixture = readFixtures().find(({ caseId }) => caseId === 'deterministic-repeat');
  const [firstInput, secondInput] = fixture.input.equivalentInputs;

  assert.deepEqual(firstInput, secondInput);
  assert.deepEqual(
    evaluateBoundedVerification(firstInput),
    evaluateBoundedVerification(secondInput)
  );
});

test('bounded verification core fails closed for malformed inputs', () => {
  assert.deepEqual(evaluateBoundedVerification(null), {
    verificationStatus: 'not_verified',
    reasonCategory: 'missing_signature_evidence'
  });
  assert.deepEqual(evaluateBoundedVerification({ signature: 'synthetic-signature-placeholder:v1:case-x' }), {
    verificationStatus: 'not_verified',
    reasonCategory: 'malformed_signature_evidence'
  });

  const positive = readFixtures().find(({ caseId }) => caseId === 'verified-supported-algorithm');
  const unknownField = JSON.parse(JSON.stringify(positive.input));
  unknownField.packageTrust = true;
  assert.deepEqual(evaluateBoundedVerification(unknownField), {
    verificationStatus: 'not_verified',
    reasonCategory: 'malformed_signature_evidence'
  });
});

test('bounded verification core rejects unbounded trusted-key metadata', () => {
  const positive = readFixtures().find(({ caseId }) => caseId === 'verified-supported-algorithm');
  const cases = [
    ['nested privateKey', (input) => { input.trustedKeyMetadata.details = { privateKey: 'synthetic-secret' }; }],
    ['nested networkEndpoint', (input) => { input.trustedKeyMetadata.details = { networkEndpoint: 'https://example.invalid' }; }],
    ['array secret', (input) => { input.trustedKeyMetadata.expiresAt = [{ secret: 'synthetic-secret' }]; }],
    ['top-level unknown field', (input) => { input.trustedKeyMetadata.unexpected = true; }]
  ];

  for (const [name, mutate] of cases) {
    const input = JSON.parse(JSON.stringify(positive.input));
    mutate(input);
    assert.deepEqual(evaluateBoundedVerification(input), {
      verificationStatus: 'not_verified',
      reasonCategory: 'malformed_trusted_key_record'
    }, name);
  }
});

test('bounded verification core rejects signature evidence smuggling', () => {
  const positive = readFixtures().find(({ caseId }) => caseId === 'verified-supported-algorithm');
  const validSignature = positive.input.signature;
  const signatures = [
    `${validSignature}:suffix`,
    `${validSignature}\n`,
    `${validSignature}:-----BEGIN PRIVATE KEY-----`,
    `${validSignature}\u0000`,
    'synthetic-signature-placeholder:v1:case-',
    'synthetic-signature-placeholder:v1:case-01:unexpected'
  ];

  for (const signature of signatures) {
    const input = JSON.parse(JSON.stringify(positive.input));
    input.signature = signature;
    assert.deepEqual(evaluateBoundedVerification(input), {
      verificationStatus: 'not_verified',
      reasonCategory: 'malformed_signature_evidence'
    }, JSON.stringify(signature));
  }
});

test('bounded verification core does not use network or system clock', () => {
  const positive = readFixtures().find(({ caseId }) => caseId === 'verified-supported-algorithm');
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  globalThis.fetch = () => {
    throw new Error('network access is forbidden');
  };
  Date.now = () => {
    throw new Error('system clock access is forbidden');
  };

  try {
    assert.deepEqual(evaluateBoundedVerification(positive.input), positive.expected);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }
});

test('bounded verification output never claims trust or authorization', () => {
  const forbiddenOutputKeys = new Set([
    'trusted',
    'authorized',
    'safe',
    'approved',
    'approvedForExecution'
  ]);

  for (const fixture of readFixtures()) {
    const actual = evaluateBoundedVerification(fixtureInput(fixture));
    for (const key of Object.keys(actual)) {
      assert.equal(forbiddenOutputKeys.has(key), false, `${fixture.caseId}: ${key}`);
    }
  }
});

test('verification core source contains no resolver, runtime, or crypto dependency', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'v5', 'verification-core.js'),
    'utf8'
  );

  assert.equal(source.includes("require('crypto')"), false);
  assert.equal(source.includes("require('http')"), false);
  assert.equal(source.includes("require('https')"), false);
  assert.equal(source.includes('fetch('), false);
  assert.equal(source.includes('Date.now('), false);
  assert.equal(source.includes('runtime-reader'), false);
  assert.equal(source.includes('runtime-writer'), false);
  assert.equal(source.includes('better-sqlite3'), false);
});

test('cryptographic evidence handoff normalizes every canonical adapter result', () => {
  const cases = [
    [{ cryptographicState: 'valid' }, { cryptographicState: 'valid' }],
    [
      { cryptographicState: 'invalid', reasonCategory: 'signature_invalid' },
      { cryptographicState: 'invalid', reasonCategory: 'signature_invalid' }
    ],
    [
      { cryptographicState: 'malformed', reasonCategory: 'message_malformed' },
      { cryptographicState: 'malformed', reasonCategory: 'message_malformed' }
    ],
    [
      { cryptographicState: 'unsupported', reasonCategory: 'algorithm_unsupported' },
      { cryptographicState: 'unsupported', reasonCategory: 'algorithm_unsupported' }
    ]
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(normalizeCryptographicVerificationEvidence(input), expected);
  }
});

test('cryptographic evidence handoff fails closed for invalid state and reason pairings', () => {
  const invalidInputs = [
    { cryptographicState: 'invalid' },
    { cryptographicState: 'valid', reasonCategory: 'signature_invalid' },
    { cryptographicState: 'invalid', reasonCategory: 'message_malformed' },
    { cryptographicState: 'malformed', reasonCategory: 'signature_invalid' },
    { cryptographicState: 'unsupported', reasonCategory: 'unknown_key' },
    { cryptographicState: 'unknown', reasonCategory: 'signature_invalid' },
    { cryptographicState: 'valid', extra: true },
    null,
    [],
    'invalid'
  ];

  for (const input of invalidInputs) {
    assert.deepEqual(normalizeCryptographicVerificationEvidence(input), {
      cryptographicState: 'malformed',
      reasonCategory: 'input_malformed'
    });
  }
});

test('cryptographic evidence handoff rejects inherited and accessor-bearing inputs without execution', () => {
  const inherited = Object.create({ cryptographicState: 'valid' });
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'cryptographicState', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'valid';
    }
  });

  for (const input of [inherited, accessor]) {
    assert.deepEqual(normalizeCryptographicVerificationEvidence(input), {
      cryptographicState: 'malformed',
      reasonCategory: 'input_malformed'
    });
  }
  assert.equal(getterCalls, 0);
});

test('cryptographic evidence handoff is deterministic, fresh, and does not mutate frozen input', () => {
  const input = Object.freeze({
    cryptographicState: 'malformed',
    reasonCategory: 'signature_malformed'
  });
  const first = normalizeCryptographicVerificationEvidence(input);
  const second = normalizeCryptographicVerificationEvidence(input);

  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first, input);
  assert.deepEqual(input, {
    cryptographicState: 'malformed',
    reasonCategory: 'signature_malformed'
  });
});

test('cryptographic evidence handoff is separate from bounded verification evaluation', () => {
  const fixture = readFixtures().find(({ caseId }) => caseId === 'verified-supported-algorithm');
  assert.deepEqual(evaluateBoundedVerification(fixture.input), fixture.expected);
  assert.deepEqual(normalizeCryptographicVerificationEvidence({
    cryptographicState: 'valid'
  }), { cryptographicState: 'valid' });
});
