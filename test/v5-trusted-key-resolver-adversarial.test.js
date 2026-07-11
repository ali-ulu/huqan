'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveTrustedKeyState } = require('../lib/v5/trusted-key-resolver');

const FIXED_TIME = '2026-02-01T12:00:00.000Z';
const MALFORMED = {
  keyState: 'malformed',
  reasonCategory: 'malformed_trusted_key_record'
};
const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'trusted-key-resolver');

function validInput(overrides = {}) {
  const keyReference = overrides.keyReference || 'test-key:adversarial-active';
  return {
    keyReference,
    records: [{
      keyReference,
      status: 'active',
      expiresAt: '2026-12-31T23:59:59.000Z'
    }],
    evaluationTime: FIXED_TIME,
    ...overrides
  };
}

function exact(result, expected) {
  assert.deepEqual(result, expected);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(expected).sort());
}

function assertMalformed(input) {
  assert.doesNotThrow(() => resolveTrustedKeyState(input));
  exact(resolveTrustedKeyState(input), MALFORMED);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('exports only the bounded resolver API', () => {
  const moduleExports = require('../lib/v5/trusted-key-resolver');
  assert.deepEqual(Object.keys(moduleExports).sort(), ['resolveTrustedKeyState']);
  assert.equal(typeof resolveTrustedKeyState, 'function');
});

test('root forms fail closed without exception leakage', () => {
  const unsupported = [
    null,
    undefined,
    true,
    42,
    'input',
    [],
    () => {},
    new Date(FIXED_TIME),
    /resolver/,
    new String('input'),
    Object.create({ keyReference: 'inherited' })
  ];

  for (const input of unsupported) {
    assertMalformed(input);
  }
});

test('null-prototype and frozen valid inputs remain bounded and usable', () => {
  const input = Object.assign(Object.create(null), validInput());
  Object.freeze(input.records[0]);
  Object.freeze(input.records);
  Object.freeze(input);

  exact(resolveTrustedKeyState(input), { keyState: 'active' });
});

test('inherited root fields and prototype-pollution-shaped fields fail closed', () => {
  const inherited = Object.create({ unexpected: true });
  Object.assign(inherited, validInput());
  assertMalformed(inherited);

  for (const key of ['constructor', 'prototype']) {
    assertMalformed(validInput({ [key]: true }));
  }

  const protoPolluted = validInput();
  Object.defineProperty(protoPolluted, '__proto__', {
    configurable: true,
    enumerable: true,
    value: true
  });
  assertMalformed(protoPolluted);
});

test('PR #237 regressions remain fail closed', () => {
  exact(
    resolveTrustedKeyState(validInput({
      evaluationTime: '2026-02-30T00:00:00.000Z'
    })),
    MALFORMED
  );
  exact(
    resolveTrustedKeyState(validInput({
      keyReference: 'https://example.invalid/key'
    })),
    MALFORMED
  );

  const sparse = new Array(1);
  exact(resolveTrustedKeyState(validInput({ records: sparse })), MALFORMED);
});

test('strict timestamps reject normalization and accept a real leap day', () => {
  for (const evaluationTime of [
    '2026-02-30T00:00:00.000Z',
    '2026-02-13T00:00:00',
    '2026-02-01T00:00:00.000',
    '2026-2-01T00:00:00.000Z',
    '2026-02-01T00:00:00.0000Z',
    '2026-02-01T00:00:00.000Zx',
    ' 2026-02-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z ',
    1770000000000
  ]) {
    assertMalformed(validInput({ evaluationTime }));
  }

  exact(
    resolveTrustedKeyState(validInput({
      records: [{
        keyReference: 'test-key:adversarial-active',
        status: 'active',
        expiresAt: '2028-02-29T00:00:00.000Z'
      }]
    })),
    { keyState: 'active' }
  );
});

test('expiry remains instant-based at before, equal, and after boundaries', () => {
  const record = {
    keyReference: 'test-key:adversarial-active',
    status: 'active'
  };

  exact(
    resolveTrustedKeyState(validInput({
      records: [{ ...record, expiresAt: '2026-02-01T11:59:59.999Z' }]
    })),
    { keyState: 'expired', reasonCategory: 'expired_key_metadata' }
  );
  exact(
    resolveTrustedKeyState(validInput({
      records: [{ ...record, expiresAt: FIXED_TIME }]
    })),
    { keyState: 'expired', reasonCategory: 'expired_key_metadata' }
  );
  exact(
    resolveTrustedKeyState(validInput({
      records: [{ ...record, expiresAt: '2026-02-01T12:00:00.001Z' }]
    })),
    { keyState: 'active' }
  );
});

test('keyReference validation is consistent for input and records', () => {
  const invalidReferences = [
    'http://example.invalid/key',
    'https://example.invalid/key',
    'file://local/key',
    'ftp://example.invalid/key',
    'ws://example.invalid/key',
    'wss://example.invalid/key',
    'provider:key',
    'user:pass@example.invalid',
    'key-host/path?query=value#fragment',
    'key\u0000reference',
    'key\nreference',
    ' key-reference',
    'key-reference ',
    '',
    'a'.repeat(257)
  ];

  for (const keyReference of invalidReferences) {
    assertMalformed(validInput({ keyReference }));
    assertMalformed(validInput({
      records: [{
        keyReference,
        status: 'active',
        expiresAt: '2026-12-31T23:59:59.000Z'
      }]
    }));
  }

  exact(resolveTrustedKeyState(validInput()), { keyState: 'active' });
  exact(
    resolveTrustedKeyState(validInput({
      keyReference: 'a'.repeat(256),
      records: [{
        keyReference: 'a'.repeat(256),
        status: 'active',
        expiresAt: '2026-12-31T23:59:59.000Z'
      }]
    })),
    { keyState: 'active' }
  );
});

test('dense array validation precedes record selection', () => {
  const record = validInput().records[0];
  const beginning = new Array(2);
  beginning[1] = record;
  const middle = [];
  middle[0] = record;
  middle[2] = record;
  const end = [];
  end.length = 2;
  end[0] = record;

  for (const records of [
    beginning,
    middle,
    end,
    [undefined],
    [null],
    [record, 'not-a-record']
  ]) {
    assertMalformed(validInput({ records }));
  }

  exact(resolveTrustedKeyState(validInput({ records: [] })), {
    keyState: 'unknown',
    reasonCategory: 'unknown_key'
  });
});

test('duplicate matching records fail closed independent of order', () => {
  const first = validInput().records[0];
  const second = { ...first };

  for (const records of [[first, second], [second, first]]) {
    exact(resolveTrustedKeyState(validInput({ records })), MALFORMED);
  }

  exact(resolveTrustedKeyState(validInput({
    records: [{
      keyReference: 'test-key:other',
      status: 'active',
      expiresAt: '2026-12-31T23:59:59.000Z'
    }]
  })), {
    keyState: 'unknown',
    reasonCategory: 'unknown_key'
  });
});

test('canonical forbidden concepts are rejected recursively', () => {
  const cases = [
    { privateKey: 'synthetic' },
    { secret: 'synthetic' },
    { aliases: [{ token: 'synthetic' }] },
    { aliases: [[{ credential: 'synthetic' }]] },
    { metadata: { password: 'synthetic' } },
    { metadata: { keyMaterial: 'synthetic' } },
    { metadata: { pem: '-----BEGIN PRIVATE KEY-----' } },
    { metadata: { provider: { endpoint: 'https://example.invalid' } } },
    { metadata: { networkEndpoint: 'https://example.invalid' } },
    { metadata: { URL: 'https://example.invalid' } }
  ];

  for (const forbidden of cases) {
    assertMalformed(validInput({
      records: [{ ...validInput().records[0], metadata: forbidden }]
    }));
  }

  assertMalformed(validInput({
    records: [{ ...validInput().records[0], Secret: 'synthetic' }]
  }));
});

test('repeated references remain deterministic and inputs remain unchanged', () => {
  const nested = {
    keyReference: 'test-key:adversarial-active',
    status: 'active',
    expiresAt: '2026-12-31T23:59:59.000Z'
  };
  const input = validInput({ records: [nested] });
  const snapshot = clone(input);
  const first = resolveTrustedKeyState(input);
  const second = resolveTrustedKeyState(input);

  exact(first, { keyState: 'active' });
  assert.deepEqual(second, first);
  assert.deepEqual(input, snapshot);
  assert.equal(input.records[0], nested);
});

test('insertion order and host globals do not alter semantic output', () => {
  const first = {
    keyReference: 'test-key:adversarial-active',
    records: [{
      keyReference: 'test-key:adversarial-active',
      status: 'active',
      expiresAt: '2026-12-31T23:59:59.000Z'
    }],
    evaluationTime: FIXED_TIME
  };
  const second = {
    evaluationTime: FIXED_TIME,
    records: [{
      expiresAt: '2026-12-31T23:59:59.000Z',
      status: 'active',
      keyReference: 'test-key:adversarial-active'
    }],
    keyReference: 'test-key:adversarial-active'
  };

  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;
  const originalTimezone = process.env.TZ;
  Date.now = () => {
    throw new Error('system clock access forbidden');
  };
  globalThis.fetch = () => {
    throw new Error('network access forbidden');
  };
  process.env.TZ = 'Pacific/Honolulu';

  try {
    exact(resolveTrustedKeyState(first), { keyState: 'active' });
    exact(resolveTrustedKeyState(second), { keyState: 'active' });
    assert.deepEqual(resolveTrustedKeyState(first), resolveTrustedKeyState(second));
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  }
});

test('bounded output excludes explanations and operational claims', () => {
  const outputs = [
    resolveTrustedKeyState(validInput()),
    resolveTrustedKeyState(validInput({ keyReference: 'missing-key' })),
    resolveTrustedKeyState(validInput({ records: [null] })),
    resolveTrustedKeyState(validInput({ keyReference: 'https://example.invalid' }))
  ];

  for (const output of outputs) {
    assert.ok(
      JSON.stringify(output) === JSON.stringify(output),
      'output must be serializable'
    );
    assert.deepEqual(
      Object.keys(output).sort(),
      Object.keys(output).filter((key) => key === 'keyState' || key === 'reasonCategory').sort()
    );
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'trust'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'authorized'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(output, 'explanation'), false);
  }
});

test('moderate bounded inputs remain finite and deterministic', () => {
  const records = Array.from({ length: 128 }, (_, index) => ({
    keyReference: 'test-key:other-' + index,
    status: 'unknown'
  }));
  const input = validInput({ records });
  const first = resolveTrustedKeyState(input);
  const second = resolveTrustedKeyState(input);

  exact(first, { keyState: 'unknown', reasonCategory: 'unknown_key' });
  assert.deepEqual(second, first);
});

test('canonical fixtures remain parseable and are not mutated by inspection', () => {
  const files = fs.readdirSync(fixtureRoot)
    .filter((file) => file.endsWith('.json'))
    .sort();

  assert.equal(files.length, 12);
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
    const snapshot = clone(fixture);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), snapshot);
  }
});
