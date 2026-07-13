'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const resolverModule = require('../lib/v5/trusted-key-resolver');
const { resolveTrustedKeyState } = resolverModule;

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'trusted-key-resolver');
const expectedFiles = [
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
const fixedTime = '2026-02-01T12:00:00.000Z';
const publicKeySpkiDerHex = '302a300506032b65700321003d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
const malformed = {
  keyState: 'malformed',
  reasonCategory: 'malformed_trusted_key_record'
};
const stateReasons = {
  unknown: 'unknown_key',
  revoked: 'revoked_key',
  expired: 'expired_key_metadata',
  unavailable: 'key_lookup_unavailable',
  malformed: 'malformed_trusted_key_record'
};

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
}

function fixtureFiles() {
  return fs.readdirSync(fixtureRoot)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

function fixtureInput(fixture, repeatIndex = 0) {
  const source = Array.isArray(fixture.input.equivalentInputs)
    ? fixture.input.equivalentInputs[repeatIndex]
    : fixture.input;
  const records = source.trustedKeyRecords
    ? source.trustedKeyRecords
    : source.trustedKeyRecord
      ? [source.trustedKeyRecord]
      : [];

  return {
    keyReference: source.keyReference,
    records: records.map((record) => ({
      ...record,
      ...(record.publicKeySpkiDer === undefined ? {} : {
        publicKeySpkiDer: Buffer.from(record.publicKeySpkiDer.hex, 'hex')
      })
    })),
    evaluationTime: source.evaluationTime
  };
}

function expectedResult(fixture) {
  const result = { keyState: fixture.expected.keyState };
  if (fixture.expected.keyState === 'active') {
    result.keyReference = fixture.expected.keyReference;
    result.publicKeySpkiDer = Buffer.from(fixture.expected.publicKeySpkiDerHex, 'hex');
  }
  if (fixture.expected.reasonCategory !== undefined) {
    result.reasonCategory = fixture.expected.reasonCategory;
  }
  return result;
}

function publicKey() {
  return Buffer.from(publicKeySpkiDerHex, 'hex');
}

function activeResult(keyReference = 'test-key:unit-active') {
  return {
    keyState: 'active',
    keyReference,
    publicKeySpkiDer: publicKey()
  };
}

function validInput(overrides = {}) {
  return {
    keyReference: 'test-key:unit-active',
    records: [{
      keyReference: 'test-key:unit-active',
      status: 'active',
      expiresAt: '2026-12-31T23:59:59.000Z',
      publicKeySpkiDer: publicKey()
    }],
    evaluationTime: fixedTime,
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotInput(input) {
  return {
    ...input,
    records: input.records.map((record) => ({
      ...record,
      ...(Buffer.isBuffer(record.publicKeySpkiDer)
        ? { publicKeySpkiDer: Buffer.from(record.publicKeySpkiDer) }
        : {})
    }))
  };
}

function assertExactOutput(result, expected) {
  assert.deepEqual(result, expected);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(expected).sort());
}

test('exports exactly the bounded resolver API', () => {
  assert.deepEqual(Object.keys(resolverModule).sort(), ['resolveTrustedKeyState']);
  assert.equal(typeof resolveTrustedKeyState, 'function');
});

test('executes all 12 fixtures with exact state and reason mapping', () => {
  assert.deepEqual(fixtureFiles(), expectedFiles);

  for (const file of expectedFiles) {
    const fixture = readFixture(file);
    assertExactOutput(
      resolveTrustedKeyState(fixtureInput(fixture)),
      expectedResult(fixture)
    );
  }
});

test('returns bounded malformed output without throwing for malformed roots', () => {
  for (const input of [null, [], {}, 'input', 42, { keyReference: 'x' }]) {
    assert.doesNotThrow(() => resolveTrustedKeyState(input));
    assertExactOutput(resolveTrustedKeyState(input), malformed);
  }

  assertExactOutput(resolveTrustedKeyState(validInput({ unexpected: true })), malformed);
});

test('rejects malformed key references and unknown record fields', () => {
  assertExactOutput(resolveTrustedKeyState(validInput({ keyReference: '' })), malformed);
  assertExactOutput(
    resolveTrustedKeyState(validInput({ keyReference: ' test-key:unit-active' })),
    malformed
  );
  assertExactOutput(
    resolveTrustedKeyState(validInput({
      records: [{ ...validInput().records[0], unknownField: true }]
    })),
    malformed
  );
});

test('rejects impossible calendar dates without normalizing them', () => {
  const malformedDates = [
    '2026-02-30T00:00:00.000Z',
    '2026-00-01T00:00:00.000Z',
    '2026-01-00T00:00:00.000Z',
    '2026-02-01T00:00:00.000'
  ];

  for (const evaluationTime of malformedDates) {
    assertExactOutput(resolveTrustedKeyState(validInput({ evaluationTime })), malformed);
  }

  assertExactOutput(
    resolveTrustedKeyState(validInput({
      records: [{ ...validInput().records[0], expiresAt: '2028-02-29T00:00:00.000Z' }]
    })),
    activeResult()
  );
});

test('rejects URL, provider, and network-shaped key references', () => {
  const invalidReferences = [
    'https://example.invalid/key',
    'http://example.invalid/key',
    'provider:key-record',
    'key-host/path?query=value#fragment'
  ];

  for (const keyReference of invalidReferences) {
    assertExactOutput(resolveTrustedKeyState(validInput({ keyReference })), malformed);
    assertExactOutput(
      resolveTrustedKeyState(validInput({
        records: [{ ...validInput().records[0], keyReference }]
      })),
      malformed
    );
  }
});

test('rejects sparse and non-object record arrays before record selection', () => {
  const record = validInput().records[0];
  const sparse = new Array(1);
  const interleaved = [];
  interleaved[0] = record;
  interleaved[2] = record;

  for (const records of [sparse, interleaved, [undefined], [null]]) {
    assertExactOutput(resolveTrustedKeyState(validInput({ records })), malformed);
  }

  assertExactOutput(resolveTrustedKeyState(validInput({ records: [record] })), {
    ...activeResult()
  });
});

test('rejects recursive secret and key material content', () => {
  const cases = [
    { metadata: { privateKey: 'synthetic-private-key' } },
    { metadata: { secret: 'synthetic-secret' } },
    { metadata: { aliases: [{ key_material: 'synthetic-key-material' }] } },
    { metadata: { aliases: [{ token: 'synthetic-token' }] } },
    { metadata: { pem: '-----BEGIN PRIVATE KEY-----' } }
  ];

  for (const nested of cases) {
    const input = validInput({
      records: [{ ...validInput().records[0], metadata: nested }]
    });
    assertExactOutput(resolveTrustedKeyState(input), malformed);
  }
});

test('rejects recursive provider and network metadata', () => {
  const cases = [
    { metadata: { provider: { endpoint: 'https://example.invalid/key' } } },
    { metadata: { networkEndpoint: 'https://example.invalid/key' } },
    { metadata: { aliases: [{ uri: 'https://example.invalid/key' }] } }
  ];

  for (const nested of cases) {
    const input = validInput({
      records: [{ ...validInput().records[0], metadata: nested }]
    });
    assertExactOutput(resolveTrustedKeyState(input), malformed);
  }
});

test('rejects malformed records and timestamps', () => {
  const invalidInputs = [
    validInput({ records: null }),
    validInput({ records: [null] }),
    validInput({
      records: [{ ...validInput().records[0], status: 'not-a-state' }]
    }),
    validInput({
      records: [{ ...validInput().records[0], expiresAt: '2026-02-01T12:00:00' }]
    }),
    validInput({
      records: [{ ...validInput().records[0], expiresAt: 'not-a-timestamp' }]
    })
  ];

  for (const input of invalidInputs) {
    assertExactOutput(resolveTrustedKeyState(input), malformed);
  }
});

test('handles zero, one, and multiple exact matches without precedence', () => {
  const one = validInput();
  const zero = validInput({
    keyReference: 'test-key:missing',
    records: one.records
  });
  const duplicate = clone(one.records[0]);
  const two = validInput({ records: [one.records[0], duplicate] });
  const reversed = validInput({ records: [duplicate, one.records[0]] });

  assertExactOutput(resolveTrustedKeyState(zero), {
    keyState: 'unknown',
    reasonCategory: stateReasons.unknown
  });
  assertExactOutput(resolveTrustedKeyState(one), activeResult());
  assertExactOutput(resolveTrustedKeyState(two), malformed);
  assertExactOutput(resolveTrustedKeyState(reversed), malformed);
});

test('evaluates unavailable, revoked, unknown, malformed, and active states', () => {
  for (const state of ['unavailable', 'revoked', 'unknown', 'malformed']) {
    const input = validInput({
      records: [{ keyReference: 'test-key:unit-active', status: state }]
    });
    const expected = state === 'malformed'
      ? malformed
      : { keyState: state, reasonCategory: stateReasons[state] };
    assertExactOutput(resolveTrustedKeyState(input), expected);
  }
});

test('applies parsed expiry semantics for less, equal, and greater instants', () => {
  const before = validInput({
    records: [{ ...validInput().records[0], expiresAt: '2026-01-31T23:59:59.999Z' }]
  });
  const equal = validInput({
    records: [{ ...validInput().records[0], expiresAt: fixedTime }]
  });
  const after = validInput({
    records: [{ ...validInput().records[0], expiresAt: '2026-02-01T12:00:00.001Z' }]
  });

  assertExactOutput(resolveTrustedKeyState(before), {
    keyState: 'expired',
    reasonCategory: stateReasons.expired
  });
  assertExactOutput(resolveTrustedKeyState(equal), {
    keyState: 'expired',
    reasonCategory: stateReasons.expired
  });
  assertExactOutput(resolveTrustedKeyState(after), activeResult());
});

test('preserves inputs and produces deterministic bounded output', () => {
  const input = validInput();
  const snapshot = snapshotInput(input);
  const first = resolveTrustedKeyState(input);
  const second = resolveTrustedKeyState(input);

  assertExactOutput(first, activeResult());
  assert.deepEqual(second, first);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(input.records, snapshot.records);
});

test('record order does not alter duplicate outcomes', () => {
  const a = {
    keyReference: 'test-key:order',
    status: 'active',
    expiresAt: '2026-12-31T23:59:59.000Z'
  };
  const b = {
    keyReference: 'test-key:order',
    status: 'revoked'
  };
  const first = resolveTrustedKeyState({
    keyReference: 'test-key:order',
    records: [a, b],
    evaluationTime: fixedTime
  });
  const second = resolveTrustedKeyState({
    keyReference: 'test-key:order',
    records: [b, a],
    evaluationTime: fixedTime
  });

  assertExactOutput(first, malformed);
  assert.deepEqual(second, first);
});

test('does not read the system clock or return forbidden output claims', () => {
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;
  Date.now = () => {
    throw new Error('system clock access forbidden');
  };
  globalThis.fetch = () => {
    throw new Error('network access forbidden');
  };

  try {
    const result = resolveTrustedKeyState(validInput());
    assertExactOutput(result, activeResult());
    assert.deepEqual(Object.keys(result).sort(), ['keyReference', 'keyState', 'publicKeySpkiDer']);
    assert.equal(Object.hasOwn(result, 'trusted'), false);
    assert.equal(Object.hasOwn(result, 'authorized'), false);
    assert.equal(Object.hasOwn(result, 'explanation'), false);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test('does not mutate fixture objects and keeps handoff output bounded', () => {
  for (const file of expectedFiles) {
    const fixture = readFixture(file);
    const before = clone(fixture);
    const result = resolveTrustedKeyState(fixtureInput(fixture));
    assert.deepEqual(fixture, before, file);
    const expectedKeys = fixture.expected.reasonCategory
      ? ['keyState', 'reasonCategory']
      : ['keyState', 'keyReference', 'publicKeySpkiDer'];
    assert.deepEqual(Object.keys(result).sort(), expectedKeys.sort());
    assert.equal(
      Object.keys(result).some((key) =>
        ['trust', 'trusted', 'authorized', 'privateKey', 'provider', 'network'].includes(key)
      ),
      false
    );
  }
});
