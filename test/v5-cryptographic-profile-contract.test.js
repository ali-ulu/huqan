'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CRYPTOGRAPHIC_PROFILE_V1,
  encodeJsonStableV1
} = require('../lib/v5/cryptographic-profile-contract');

function bytes(value) {
  return Array.from(encodeJsonStableV1(value));
}

test('exports the immutable V1 profile and canonical byte producer', () => {
  const moduleExports = require('../lib/v5/cryptographic-profile-contract');
  assert.deepEqual(Object.keys(moduleExports).sort(), [
    'CRYPTOGRAPHIC_PROFILE_V1',
    'encodeJsonStableV1'
  ]);
  assert.equal(CRYPTOGRAPHIC_PROFILE_V1.profileId, 'ed25519-v1');
  assert.equal(CRYPTOGRAPHIC_PROFILE_V1.signedContentMode, 'canonical-message-bytes');
  assert.equal(CRYPTOGRAPHIC_PROFILE_V1.canonicalization, 'json-stable-v1');
  assert.equal(CRYPTOGRAPHIC_PROFILE_V1.textEncoding, 'utf-8');
  assert.deepEqual(CRYPTOGRAPHIC_PROFILE_V1.messageBytes, {
    minimum: 1,
    maximum: 1048576
  });
  assert.deepEqual(CRYPTOGRAPHIC_PROFILE_V1.publicKey, {
    representation: 'ed25519-spki-der',
    exactLength: 44
  });
  assert.deepEqual(CRYPTOGRAPHIC_PROFILE_V1.signature, {
    representation: 'ed25519-raw',
    exactLength: 64
  });
  assert.throws(() => {
    CRYPTOGRAPHIC_PROFILE_V1.messageBytes.maximum = 1;
  }, TypeError);
  assert.equal(CRYPTOGRAPHIC_PROFILE_V1.messageBytes.maximum, 1048576);
});

test('uses UTF-16 code-unit key ordering with exact json-stable-v1 bytes', () => {
  assert.deepEqual(
    bytes({ b: 1, a: 'x', '2': 'two', '10': 'ten' }),
    Array.from(Buffer.from('{"10":"ten","2":"two","a":"x","b":1}', 'utf8'))
  );
  assert.deepEqual(
    bytes({ outer: { z: true, a: [3, { b: 2, a: 1 }] } }),
    Array.from(Buffer.from('{"outer":{"a":[3,{"a":1,"b":2}],"z":true}}', 'utf8'))
  );
  assert.deepEqual(bytes({ text: 'cafe' }), Array.from(Buffer.from('{"text":"cafe"}', 'utf8')));
});

test('preserves array order and JSON primitive semantics', () => {
  assert.equal(encodeJsonStableV1([3, 1, 2]).toString('utf8'), '[3,1,2]');
  assert.equal(encodeJsonStableV1(-0).toString('utf8'), '0');
  assert.equal(encodeJsonStableV1(null).toString('utf8'), 'null');
  assert.equal(encodeJsonStableV1(true).toString('utf8'), 'true');
  assert.equal(encodeJsonStableV1('line\\nquote"').toString('utf8'), '"line\\\\nquote\\\""');
});

test('returns UTF-8 bytes without a BOM or trailing newline', () => {
  const result = encodeJsonStableV1({ text: 'Istanbul' });
  assert.deepEqual(result, Buffer.from('{"text":"Istanbul"}', 'utf8'));
  assert.notEqual(result[0], 0xef);
  assert.notEqual(result[result.length - 1], 0x0a);
});

test('accepts null-prototype JSON objects without mutation', () => {
  const value = Object.assign(Object.create(null), {
    b: 2,
    a: { z: false }
  });
  const before = { b: value.b, a: { z: value.a.z } };

  assert.equal(encodeJsonStableV1(value).toString('utf8'), '{"a":{"z":false},"b":2}');
  assert.deepEqual({ b: value.b, a: { z: value.a.z } }, before);
});

test('repeated canonicalization is byte-identical and locale independent', () => {
  const value = { z: ['x', { b: 2, a: 1 }], a: 'stable' };
  const originalLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = () => {
    throw new Error('locale ordering is forbidden');
  };

  try {
    const first = encodeJsonStableV1(value);
    const second = encodeJsonStableV1(value);
    assert.deepEqual(first, second);
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
});

test('rejects unsupported primitives, non-finite numbers, and application byte values', () => {
  for (const value of [
    undefined,
    () => {},
    Symbol('value'),
    1n,
    NaN,
    Infinity,
    -Infinity,
    Buffer.from([1]),
    new Uint8Array([1])
  ]) {
    assert.throws(() => encodeJsonStableV1(value), TypeError);
  }
});

test('rejects sparse arrays and array accessors without executing them', () => {
  const sparse = new Array(2);
  sparse[1] = 'value';
  assert.throws(() => encodeJsonStableV1(sparse), TypeError);

  let getterCalled = false;
  const accessorArray = [];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'unsafe';
    }
  });
  accessorArray.length = 1;
  assert.throws(() => encodeJsonStableV1(accessorArray), TypeError);
  assert.equal(getterCalled, false);
});

test('rejects getters, setters, symbols, toJSON, and inherited enumerable state', () => {
  let getterCalled = false;
  const getterValue = {};
  Object.defineProperty(getterValue, 'unsafe', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'unsafe';
    }
  });
  assert.throws(() => encodeJsonStableV1(getterValue), TypeError);
  assert.equal(getterCalled, false);

  let toJsonCalled = false;
  const customToJson = {
    toJSON() {
      toJsonCalled = true;
      return 'unsafe';
    }
  };
  assert.throws(() => encodeJsonStableV1(customToJson), TypeError);
  assert.equal(toJsonCalled, false);

  const symbolValue = { safe: true };
  symbolValue[Symbol('hidden')] = 'unsafe';
  assert.throws(() => encodeJsonStableV1(symbolValue), TypeError);

  const inherited = Object.create({ inherited: true });
  inherited.safe = true;
  assert.throws(() => encodeJsonStableV1(inherited), TypeError);
});

test('rejects non-plain objects and cyclic graphs', () => {
  for (const value of [
    new Date(),
    /value/,
    new Map(),
    new Set(),
    new (class CustomValue {})()
  ]) {
    assert.throws(() => encodeJsonStableV1(value), TypeError);
  }

  const cycle = { self: null };
  cycle.self = cycle;
  assert.throws(() => encodeJsonStableV1(cycle), TypeError);
});

test('rejects over-limit canonical messages without mutating the input', () => {
  const value = { message: 'x'.repeat(1048576) };
  const original = value.message;
  assert.throws(() => encodeJsonStableV1(value), RangeError);
  assert.equal(value.message, original);
});
