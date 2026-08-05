const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PII_TYPES,
  isValidTckn,
  isValidLuhn,
  findPiiInText,
  evaluateEgress,
} = require('../lib/data-egress-gate');

test('isValidTckn accepts a checksum-valid TCKN and rejects an invalid one', () => {
  assert.equal(isValidTckn('10000000146'), true);
  assert.equal(isValidTckn('12345678901'), false);
  assert.equal(isValidTckn('0123456789'), false, 'must be exactly 11 digits');
});

test('isValidLuhn accepts a checksum-valid card number and rejects a mutated one', () => {
  assert.equal(isValidLuhn('4111111111111111'), true);
  assert.equal(isValidLuhn('4111111111111112'), false);
});

test('findPiiInText finds an email address', () => {
  const findings = findPiiInText('reach me at ali@example.com please');
  assert.ok(findings.some((f) => f.type === PII_TYPES.EMAIL && f.match === 'ali@example.com'));
});

test('findPiiInText finds a dashed US SSN', () => {
  const findings = findPiiInText('ssn: 123-45-6789');
  assert.ok(findings.some((f) => f.type === PII_TYPES.SSN));
});

test('findPiiInText finds an international phone number with a leading +', () => {
  const findings = findPiiInText('call +90 532 123 45 67 for support');
  assert.ok(findings.some((f) => f.type === PII_TYPES.PHONE));
});

test('findPiiInText finds a checksum-valid TCKN embedded in text', () => {
  const findings = findPiiInText('tckn: 10000000146');
  assert.ok(findings.some((f) => f.type === PII_TYPES.TCKN));
});

test('findPiiInText finds a checksum-valid credit card number', () => {
  const findings = findPiiInText('card 4111111111111111 on file');
  assert.ok(findings.some((f) => f.type === PII_TYPES.CREDIT_CARD));
});

test('findPiiInText does not flag non-PII numeric-looking strings (low false-positive rate)', () => {
  assert.deepEqual(findPiiInText('2026-08-05T21:43:39Z'), []);
  assert.deepEqual(findPiiInText('550e8400-e29b-41d4-a716-446655440000'), []);
  assert.deepEqual(findPiiInText('order-1029384756'), []);
  assert.deepEqual(findPiiInText('kedi hayvandir ve 5 tane ayagi vardir'), []);
  assert.deepEqual(findPiiInText('12345678901'), [], 'checksum-invalid 11-digit run must not be flagged as TCKN');
});

test('evaluateEgress redacts PII and reuses AB7 to redact secrets in the same payload', () => {
  const result = evaluateEgress({
    text: 'contact ali@example.com',
    apiKey: 'sk-abcdefghijklmnop',
    note: 'kedi hayvandir',
  });

  assert.equal(result.piiDetected, true);
  assert.deepEqual(result.piiTypes, [PII_TYPES.EMAIL]);
  assert.equal(result.secretDetected, true);
  assert.equal(result.scrubbed.text, 'contact [REDACTED_PII:email]');
  assert.equal(result.scrubbed.apiKey, '[REDACTED]');
  assert.equal(result.scrubbed.note, 'kedi hayvandir');
});

test('evaluateEgress leaves a payload with no PII or secrets unchanged', () => {
  const payload = { text: 'kedi hayvandir', count: 3 };
  const result = evaluateEgress(payload);

  assert.equal(result.piiDetected, false);
  assert.equal(result.secretDetected, false);
  assert.deepEqual(result.scrubbed, payload);
});

test('evaluateEgress redacts nested PII, preserving structure', () => {
  const result = evaluateEgress({
    profile: { email: 'ali@example.com', tckn: '10000000146' },
    items: [{ card: '4111111111111111' }, { safe: 'value' }],
  });

  assert.equal(result.piiDetected, true);
  assert.equal(result.scrubbed.profile.email, '[REDACTED_PII:email]');
  assert.equal(result.scrubbed.profile.tckn, '[REDACTED_PII:tckn]');
  assert.equal(result.scrubbed.items[0].card, '[REDACTED_PII:credit_card]');
  assert.equal(result.scrubbed.items[1].safe, 'value');
});
