'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateTotpSecret, base32Encode, base32Decode, otpauthUri, totpAt, verifyTotp, TOTP_STEP_SECONDS,
} = require('../lib/authority/totp');

// RFC 6238 Appendix B, SHA-1 column: the shared secret is the ASCII string
// "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];

const counterAt = seconds => Math.floor(seconds / TOTP_STEP_SECONDS);
const msAt = seconds => seconds * 1000;

test('totpAt reproduces the RFC 6238 SHA-1 test vectors', () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    assert.equal(totpAt(RFC_SECRET, counterAt(seconds), 8), expected, `T=${seconds}`);
  }
  assert.equal(totpAt(RFC_SECRET, counterAt(59)), '287082');
});

test('base32 round-trips and matches RFC 4648 without padding', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.deepEqual(base32Decode('mzxw6ytboi'), Buffer.from('foobar'));
  const secret = generateTotpSecret();
  assert.equal(secret.length, 20);
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  assert.throws(() => base32Decode('MZXW1'), /base32/);
  for (const bad of ['', 'M', 'MZX', 'MZXW6Y', 'MZXW6YTBOJ']) assert.throws(() => base32Decode(bad), /base32/, bad);
});

test('otpauthUri carries the secret, issuer and parameters an authenticator app reads', () => {
  const uri = otpauthUri({ secret: Buffer.from('foobar'), account: 'operator', issuer: 'HUQAN Authority' });
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.host, 'totp');
  assert.equal(decodeURIComponent(parsed.pathname), '/HUQAN Authority:operator');
  assert.equal(parsed.searchParams.get('secret'), 'MZXW6YTBOI');
  assert.equal(parsed.searchParams.get('issuer'), 'HUQAN Authority');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
  assert.equal(uri.includes('+'), false, 'a space must not be written as +');
  assert.match(uri, /issuer=HUQAN%20Authority/);
});

test('verifyTotp accepts the current step and one step either side, and nothing further', () => {
  const now = msAt(1111111111);
  const current = counterAt(1111111111);
  for (const offset of [-1, 0, 1]) {
    const result = verifyTotp({ secret: RFC_SECRET, code: totpAt(RFC_SECRET, current + offset), now });
    assert.deepEqual(result, { ok: true, counter: current + offset }, `offset ${offset}`);
  }
  for (const offset of [-2, 2]) {
    const result = verifyTotp({ secret: RFC_SECRET, code: totpAt(RFC_SECRET, current + offset), now });
    assert.deepEqual(result, { ok: false, reason: 'invalid' }, `offset ${offset}`);
  }
});

test('verifyTotp refuses a code whose step was already used, or an earlier one', () => {
  const now = msAt(1111111111);
  const current = counterAt(1111111111);
  const code = totpAt(RFC_SECRET, current);
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, now, lastCounter: current }), { ok: false, reason: 'replayed' });
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code: totpAt(RFC_SECRET, current - 1), now, lastCounter: current - 1 }),
    { ok: false, reason: 'replayed' });
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, now, lastCounter: current - 1 }), { ok: true, counter: current });
});

test('verifyTotp refuses malformed input instead of comparing it', () => {
  const now = msAt(59);
  for (const code of ['', '12345', '1234567', '12a456', null, 287082]) {
    assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code, now }), { ok: false, reason: 'malformed' }, String(code));
  }
  assert.deepEqual(verifyTotp({ secret: Buffer.alloc(0), code: '287082', now }), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyTotp({ secret: Buffer.alloc(15, 1), code: '287082', now }), { ok: false, reason: 'malformed' },
    'a secret under 128 bits is refused');
  assert.deepEqual(verifyTotp({ secret: RFC_SECRET, code: '287082', now: Number.NaN }), { ok: false, reason: 'malformed' });
});
