'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveTrustedKeyState } = require('../lib/v5/trusted-key-resolver');

const fixtureRoot = path.join(__dirname, 'fixtures', 'v5', 'trusted-key-resolver-binding');
const fixtureTable = [
  ['01-active-buffer-bound-key.json', '01-active-buffer-bound-key'],
  ['02-active-uint8array-bound-key.json', '02-active-uint8array-bound-key'],
  ['03-active-opaque-44-byte-key.json', '03-active-opaque-44-byte-key'],
  ['04-active-missing-key.json', '04-active-missing-key'],
  ['05-active-null-key.json', '05-active-null-key'],
  ['06-active-string-key.json', '06-active-string-key'],
  ['07-active-key-one-byte-short.json', '07-active-key-one-byte-short'],
  ['08-active-key-one-byte-long.json', '08-active-key-one-byte-long'],
  ['09-revoked-without-key.json', '09-revoked-without-key'],
  ['10-revoked-with-valid-key.json', '10-revoked-with-valid-key'],
  ['11-revoked-with-malformed-present-key.json', '11-revoked-with-malformed-present-key'],
  ['12-expired-with-valid-key.json', '12-expired-with-valid-key'],
  ['13-unavailable-with-valid-key.json', '13-unavailable-with-valid-key'],
  ['14-unknown-empty-records.json', '14-unknown-empty-records'],
  ['15-unknown-reference-mismatch-same-key.json', '15-unknown-reference-mismatch-same-key'],
  ['16-ambiguous-duplicate-same-key.json', '16-ambiguous-duplicate-same-key'],
  ['17-ambiguous-duplicate-different-keys.json', '17-ambiguous-duplicate-different-keys'],
  ['18-malformed-record-forbidden-public-key-field.json', '18-malformed-record-forbidden-public-key-field'],
  ['19-malformed-root-parallel-public-key.json', '19-malformed-root-parallel-public-key'],
  ['20-malformed-nonmatching-record-before-selection.json', '20-malformed-nonmatching-record-before-selection']
];

const malformed = {
  keyState: 'malformed',
  reasonCategory: 'malformed_trusted_key_record'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function decodeHex(value) {
  assert.match(value, /^[0-9a-f]+$/);
  assert.equal(value.length % 2, 0);
  const bytes = Buffer.from(value, 'hex');
  assert.equal(bytes.toString('hex'), value);
  return bytes;
}

function materializeDescriptor(value) {
  if (value.kind === 'buffer-hex') return Buffer.from(decodeHex(value.hex));
  if (value.kind === 'uint8array-hex') return new Uint8Array(decodeHex(value.hex));
  if (value.kind === 'raw-json') return value.value;
  throw new Error(`Unsupported fixture descriptor: ${value.kind}`);
}

function materialize(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => materialize(item));
  if (!value || typeof value !== 'object') return value;
  if (key === 'publicKeySpkiDer') return materializeDescriptor(value);
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    materialize(entryValue, entryKey)
  ]));
}

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
}

function activeInput(key, keyReference = 'test-key:active') {
  return {
    keyReference,
    evaluationTime: '2026-07-01T00:00:00.000Z',
    records: [{ keyReference, status: 'active', publicKeySpkiDer: key }]
  };
}

function assertNoKeyMaterial(result) {
  assert.deepEqual(Object.keys(result).sort(), ['keyState', 'reasonCategory']);
  assert.equal(Object.hasOwn(result, 'keyReference'), false);
  assert.equal(Object.hasOwn(result, 'publicKeySpkiDer'), false);
}

test('executes every binding fixture once with exact runtime outputs', () => {
  const diskFiles = fs.readdirSync(fixtureRoot).filter((file) => file.endsWith('.json')).sort();
  assert.deepEqual(diskFiles, fixtureTable.map(([file]) => file));
  assert.equal(new Set(fixtureTable.map(([, caseId]) => caseId)).size, 20);

  const executed = new Set();
  for (const [file, caseId] of fixtureTable) {
    const fixture = loadFixture(file);
    assert.equal(fixture.caseId, caseId);
    assert.equal(executed.has(caseId), false);
    executed.add(caseId);

    const result = resolveTrustedKeyState(materialize(clone(fixture.input)));
    if (fixture.expected.keyState === 'active') {
      assert.deepEqual(Object.keys(result).sort(), ['keyReference', 'keyState', 'publicKeySpkiDer']);
      assert.equal(result.keyState, 'active');
      assert.equal(result.keyReference, fixture.expected.keyReference);
      assert.equal(Buffer.isBuffer(result.publicKeySpkiDer), true);
      assert.equal(result.publicKeySpkiDer.length, 44);
      assert.deepEqual(result.publicKeySpkiDer, decodeHex(fixture.expected.publicKeySpkiDerHex));
    } else {
      assert.deepEqual(result, fixture.expected);
      assertNoKeyMaterial(result);
    }
  }

  assert.equal(executed.size, 20);
});

test('preserves whole-record precedence and exact fixture invariants', () => {
  const byCaseId = new Map(fixtureTable.map(([file]) => {
    const fixture = loadFixture(file);
    return [fixture.caseId, fixture];
  }));

  for (const caseId of ['11-revoked-with-malformed-present-key', '20-malformed-nonmatching-record-before-selection']) {
    assert.deepEqual(resolveTrustedKeyState(materialize(clone(byCaseId.get(caseId).input))), malformed);
  }
  assert.deepEqual(
    resolveTrustedKeyState(materialize(clone(byCaseId.get('15-unknown-reference-mismatch-same-key').input))),
    { keyState: 'unknown', reasonCategory: 'unknown_key' }
  );
  const duplicateSame = resolveTrustedKeyState(materialize(clone(byCaseId.get('16-ambiguous-duplicate-same-key').input)));
  const duplicateDifferent = resolveTrustedKeyState(materialize(clone(byCaseId.get('17-ambiguous-duplicate-different-keys').input)));
  assert.deepEqual(duplicateSame, malformed);
  assert.deepEqual(duplicateDifferent, malformed);
});

test('returns defensive Buffer copies for Buffer and Uint8Array inputs', () => {
  const buffer = Buffer.alloc(44, 0x41);
  const bufferInput = activeInput(buffer);
  const bufferResult = resolveTrustedKeyState(bufferInput);
  assert.equal(Buffer.isBuffer(bufferResult.publicKeySpkiDer), true);
  assert.notEqual(bufferResult.publicKeySpkiDer, buffer);
  assert.deepEqual(bufferResult.publicKeySpkiDer, buffer);
  bufferResult.publicKeySpkiDer[0] = 0x42;
  assert.equal(buffer[0], 0x41);
  buffer[1] = 0x43;
  assert.equal(bufferResult.publicKeySpkiDer[1], 0x41);

  const backing = new Uint8Array(60);
  backing.fill(0xee);
  const view = new Uint8Array(backing.buffer, 8, 44);
  view.fill(0x51);
  const viewInput = activeInput(view, 'test-key:view');
  const viewResult = resolveTrustedKeyState(viewInput);
  assert.equal(Buffer.isBuffer(viewResult.publicKeySpkiDer), true);
  assert.deepEqual(viewResult.publicKeySpkiDer, Buffer.alloc(44, 0x51));
  assert.equal(backing[0], 0xee);
  assert.equal(backing[59], 0xee);
  view[0] = 0x52;
  assert.equal(viewResult.publicKeySpkiDer[0], 0x51);
});

test('is deterministic, immutable, and returns fresh active outputs', () => {
  const key = Buffer.alloc(44, 0x61);
  const input = activeInput(key, 'test-key:deterministic');
  const snapshot = {
    keyReference: input.keyReference,
    evaluationTime: input.evaluationTime,
    records: [{ ...input.records[0], publicKeySpkiDer: Buffer.from(key) }]
  };
  const first = resolveTrustedKeyState(input);
  const second = resolveTrustedKeyState(input);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.publicKeySpkiDer, second.publicKeySpkiDer);
  first.publicKeySpkiDer[0] = 0x00;
  assert.equal(second.publicKeySpkiDer[0], 0x61);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(key, Buffer.alloc(44, 0x61));
});

test('fails closed for descriptor and root-parallel key material', () => {
  const keyHex = Buffer.alloc(44, 0x71).toString('hex');
  const descriptor = activeInput({ kind: 'buffer-hex', hex: keyHex }, 'test-key:descriptor');
  assert.deepEqual(resolveTrustedKeyState(descriptor), malformed);

  const parallel = activeInput(Buffer.alloc(44, 0x72), 'test-key:parallel');
  parallel.publicKeySpkiDer = Buffer.alloc(44, 0x73);
  assert.deepEqual(resolveTrustedKeyState(parallel), malformed);
});

test('keeps lifecycle results confined and accepts opaque bounded bytes without crypto', () => {
  const opaque = Buffer.alloc(44, 0x7f);
  const active = resolveTrustedKeyState(activeInput(opaque, 'test-key:opaque'));
  assert.equal(active.keyState, 'active');
  assert.deepEqual(active.publicKeySpkiDer, opaque);

  for (const [status, expected] of [
    ['revoked', { keyState: 'revoked', reasonCategory: 'revoked_key' }],
    ['unavailable', { keyState: 'unavailable', reasonCategory: 'key_lookup_unavailable' }],
    ['expired', { keyState: 'expired', reasonCategory: 'expired_key_metadata' }]
  ]) {
    const input = activeInput(Buffer.alloc(44, 0x7a), `test-key:${status}`);
    input.records[0].status = status;
    const result = resolveTrustedKeyState(input);
    assert.deepEqual(result, expected);
    assertNoKeyMaterial(result);
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'v5', 'trusted-key-resolver.js'), 'utf8');
  assert.doesNotMatch(source, /node:crypto|cryptographic-verification-adapter|verification-core/);
});
