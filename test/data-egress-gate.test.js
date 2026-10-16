const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PII_TYPES,
  isValidTckn,
  isValidLuhn,
  isValidIban,
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

test('findPiiInText detects checksum-valid cards across common separators and padded digit runs (#1108)', () => {
  for (const value of ['4111.1111.1111.1111', '4111/1111_1111-1111', '99994111111111111111']) {
    assert.ok(findPiiInText(value).some((finding) => finding.type === PII_TYPES.CREDIT_CARD), value);
  }
});

test('evaluateEgress redacts checksum-valid TCKNs inside padded digit runs (#1108)', () => {
  const result = evaluateEgress({ note: 'id=0010000000146' });
  assert.equal(result.piiDetected, true);
  assert.deepEqual(result.piiTypes, [PII_TYPES.TCKN]);
  assert.equal(result.scrubbed.note, 'id=[REDACTED_PII:tckn]');
});

test('evaluateEgress does not classify a card-shaped substring inside an invalid IBAN', () => {
  const value = 'TR004111111111111111';
  const result = evaluateEgress({ note: value });
  assert.equal(result.piiDetected, false);
  assert.equal(result.scrubbed.note, value);
});

test('isValidIban accepts a checksum-valid Turkish IBAN and rejects a mutated one (#1315)', () => {
  assert.equal(isValidIban('TR330006100519786457841326'), true);
  assert.equal(isValidIban('TR330006100519786457841327'), false);
});

test('findPiiInText finds a checksum-valid IBAN embedded in text (#1315)', () => {
  const findings = findPiiInText('Odeme IBAN TR330006100519786457841326 hesabina gonderildi.');
  assert.ok(findings.some((f) => f.type === PII_TYPES.IBAN && f.match === 'TR330006100519786457841326'));
});

test('evaluateEgress redacts a checksum-valid IBAN and leaves an invalid one alone (#1315)', () => {
  const valid = evaluateEgress({ text: 'IBAN TR330006100519786457841326 hesabina gonderildi.' });
  assert.equal(valid.piiDetected, true);
  assert.deepEqual(valid.piiTypes, [PII_TYPES.IBAN]);
  assert.equal(valid.scrubbed.text, 'IBAN [REDACTED_PII:iban] hesabina gonderildi.');

  const invalid = evaluateEgress({ text: 'ref TR330006100519786457841327 kaydedildi' });
  assert.equal(invalid.piiDetected, false);
  assert.equal(invalid.scrubbed.text, 'ref TR330006100519786457841327 kaydedildi');
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
