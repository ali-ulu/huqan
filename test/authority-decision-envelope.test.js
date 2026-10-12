'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  keyIdFor, requestDigestOf, signDecision, verifyDecision, signResponse, verifyResponse, DECISION_VERSION,
} = require('../lib/authority/decision-envelope');
const { stableStringify } = require('../lib/hash-chain');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const NOW = Date.parse('2026-10-12T12:00:00.000Z');

const PAYLOAD = Object.freeze({
  v: DECISION_VERSION,
  approvalId: 'apr_1',
  workspaceId: 'default',
  tool: 'huqan.learn',
  actionHash: 'a'.repeat(64),
  decision: 'approved',
  reason: 'looks right',
  decidedAt: '2026-10-12T11:59:00.000Z',
  validUntil: '2026-10-12T12:10:00.000Z',
  ledgerSeq: 7,
  ledgerHash: 'b'.repeat(64),
  operator: 'totp:primary',
});
const EXPECTED = Object.freeze({
  approvalId: 'apr_1', workspaceId: 'default', tool: 'huqan.learn', actionHash: 'a'.repeat(64), decision: 'approved',
});
// One valid alternative per signed field. A field added to the payload without
// a row here fails the coverage assertion below instead of going untested.
const TAMPERED = Object.freeze({
  approvalId: 'apr_2', workspaceId: 'other', tool: 'huqan.ingest_execute', actionHash: 'c'.repeat(64),
  decision: 'rejected', reason: 'changed', decidedAt: '2026-10-12T11:58:00.000Z', validUntil: '2026-10-12T12:20:00.000Z',
  ledgerSeq: 8, ledgerHash: 'd'.repeat(64), operator: 'totp:other',
});
const REQUEST = Object.freeze({ method: 'GET', path: '/v1/approvals/apr_1/decision', requestDigest: requestDigestOf('') });

test('a signed decision verifies against the expected binding', () => {
  const envelope = signDecision(PAYLOAD, privateKey);
  assert.equal(envelope.alg, 'Ed25519');
  assert.equal(envelope.keyId, keyIdFor(publicKey));
  assert.match(envelope.keyId, /^[0-9a-f]{16}$/);
  assert.deepEqual(verifyDecision(envelope, { publicKey, expected: EXPECTED, now: NOW }), { ok: true, payload: PAYLOAD });
});

test('changing any signed field after signing breaks the signature', () => {
  assert.deepEqual(Object.keys(TAMPERED).sort(), Object.keys(PAYLOAD).filter(field => field !== 'v').sort());
  const envelope = signDecision(PAYLOAD, privateKey);
  for (const [field, changed] of Object.entries(TAMPERED)) {
    const tampered = { ...envelope, payload: { ...envelope.payload, [field]: changed } };
    const result = verifyDecision(tampered, { publicKey, expected: { ...EXPECTED, [field]: changed }, now: NOW });
    assert.deepEqual(result, { ok: false, code: 'signature_invalid' }, field);
  }
});

test('a decision signed for one action does not authorize another', () => {
  const envelope = signDecision(PAYLOAD, privateKey);
  for (const field of Object.keys(EXPECTED)) {
    assert.deepEqual(verifyDecision(envelope, { publicKey, expected: { ...EXPECTED, [field]: TAMPERED[field] }, now: NOW }),
      { ok: false, code: 'binding_mismatch' }, field);
  }
});

test('a decision from another key, or past its validity, is refused', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const envelope = signDecision(PAYLOAD, other.privateKey);
  assert.deepEqual(verifyDecision(envelope, { publicKey, expected: EXPECTED, now: NOW }), { ok: false, code: 'key_mismatch' });
  const forged = { ...envelope, keyId: keyIdFor(publicKey) };
  assert.deepEqual(verifyDecision(forged, { publicKey, expected: EXPECTED, now: NOW }), { ok: false, code: 'signature_invalid' });
  const valid = signDecision(PAYLOAD, privateKey);
  assert.deepEqual(verifyDecision(valid, { publicKey, expected: EXPECTED, now: Date.parse(PAYLOAD.validUntil) }),
    { ok: false, code: 'expired' });
});

test('signDecision refuses a malformed payload or an unbounded validity window', () => {
  for (const [field, value] of [['decision', 'maybe'], ['actionHash', 'xyz'], ['ledgerSeq', -1], ['validUntil', 'soon'],
    ['approvalId', ''], ['reason', 'r'.repeat(513)], ['v', 'other'], ['validUntil', 'Mon, 12 Oct 2026 12:10:00 GMT'],
    ['validUntil', '2026-10-12T11:59:00.000Z'], ['validUntil', '2026-10-12T13:00:00.001Z']]) {
    assert.throws(() => signDecision({ ...PAYLOAD, [field]: value }, privateKey), TypeError, `${field}=${value}`);
  }
  assert.throws(() => signDecision({ ...PAYLOAD, extra: 1 }, privateKey), TypeError);
  const { privateKey: ecKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => signDecision(PAYLOAD, ecKey), /ed25519/);
});

test('verifyDecision refuses a pinned key that is not Ed25519 instead of verifying under it', () => {
  const { publicKey: rsaKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyDecision(signDecision(PAYLOAD, privateKey), { publicKey: rsaKey, expected: EXPECTED, now: NOW }),
    /ed25519/);
});

test('verifyDecision reports malformed envelopes without throwing', () => {
  for (const envelope of [null, 'x', {}, { alg: 'RS256', keyId: keyIdFor(publicKey), sig: 'x', payload: PAYLOAD }]) {
    assert.deepEqual(verifyDecision(envelope, { publicKey, expected: EXPECTED, now: NOW }), { ok: false, code: 'malformed' });
  }
});

test('only the canonical encoding of a signature is accepted', () => {
  const envelope = signDecision(PAYLOAD, privateKey);
  for (const sig of [`${envelope.sig}=`, ` ${envelope.sig}`, `${envelope.sig.slice(0, -1)}B`, envelope.sig.slice(1)]) {
    assert.deepEqual(verifyDecision({ ...envelope, sig }, { publicKey, expected: EXPECTED, now: NOW }),
      { ok: false, code: 'signature_invalid' }, JSON.stringify(sig));
  }
});

test('a signed response verifies only for the challenge and request it answered', () => {
  const challenge = crypto.randomBytes(32).toString('hex');
  const response = signResponse({ status: 'pending' }, { challenge, ...REQUEST }, privateKey);
  assert.deepEqual(verifyResponse(response, { publicKey, challenge, ...REQUEST }), { ok: true, body: { status: 'pending' } });
  const other = crypto.randomBytes(32).toString('hex');
  assert.deepEqual(verifyResponse(response, { publicKey, challenge: other, ...REQUEST }), { ok: false, code: 'challenge_mismatch' });
  assert.deepEqual(verifyResponse({ ...response, challenge: other }, { publicKey, challenge: other, ...REQUEST }),
    { ok: false, code: 'signature_invalid' });
  for (const [field, value] of [['method', 'POST'], ['path', '/v1/approvals/apr_2/decision'], ['requestDigest', requestDigestOf('{}')]]) {
    assert.deepEqual(verifyResponse(response, { publicKey, challenge, ...REQUEST, [field]: value }),
      { ok: false, code: 'request_mismatch' }, field);
  }
  const impostor = crypto.generateKeyPairSync('ed25519');
  assert.deepEqual(verifyResponse(signResponse({ status: 'pending' }, { challenge, ...REQUEST }, impostor.privateKey),
    { publicKey, challenge, ...REQUEST }), { ok: false, code: 'key_mismatch' });
});

// The two envelope shapes differ today, so the test below would pass without
// domain prefixes. This one pins the prefix itself: a response body that ever
// took a decision payload's shape still could not verify as a decision.
test('a response signature never verifies under the decision domain', () => {
  const challenge = crypto.randomBytes(32).toString('hex');
  const response = signResponse(PAYLOAD, { challenge, ...REQUEST }, privateKey);
  const signedAsDecision = Buffer.from(`${DECISION_VERSION}\n${stableStringify({ challenge, ...REQUEST, body: PAYLOAD })}`, 'utf8');
  assert.equal(crypto.verify(null, signedAsDecision, publicKey, Buffer.from(response.sig, 'base64url')), false);
});

test('a decision signature cannot be presented as a response signature, or the reverse', () => {
  const challenge = crypto.randomBytes(32).toString('hex');
  const envelope = signDecision(PAYLOAD, privateKey);
  const asResponse = { body: PAYLOAD, challenge, ...REQUEST, keyId: envelope.keyId, sig: envelope.sig };
  assert.equal(verifyResponse(asResponse, { publicKey, challenge, ...REQUEST }).code, 'signature_invalid');
  const response = signResponse(PAYLOAD, { challenge, ...REQUEST }, privateKey);
  const asDecision = { alg: 'Ed25519', keyId: response.keyId, sig: response.sig, payload: PAYLOAD };
  assert.equal(verifyDecision(asDecision, { publicKey, expected: EXPECTED, now: NOW }).code, 'signature_invalid');
});
