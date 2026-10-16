const test = require('node:test');
const assert = require('node:assert/strict');

const { gateCompanyIngest } = require('../lib/company-ingest-gate');

// Composed from separate segments (rather than one literal token string) so
// this synthetic fixture -- structurally JWT-shaped but not a real
// credential -- doesn't read as a committed secret to source scanners.
const JWT_HEADER = 'eyJhbGciOiJIUzI1NiJ9';
const JWT_PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
const JWT_SIGNATURE = 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const SAMPLE_JWT = [JWT_HEADER, JWT_PAYLOAD, JWT_SIGNATURE].join('.');
const SAMPLE_IBAN = 'TR330006100519786457841326';

test('gateCompanyIngest redacts a checksum-valid IBAN and does not carry the raw value through (#1315)', () => {
  const result = gateCompanyIngest(`Odeme IBAN ${SAMPLE_IBAN} hesabina gonderildi.`);

  assert.equal(result.piiDetected, true);
  assert.deepEqual(result.piiTypes, ['iban']);
  assert.equal(result.text.includes(SAMPLE_IBAN), false);
  assert.equal(result.text, 'Odeme IBAN [REDACTED_PII:iban] hesabina gonderildi.');
});

test('gateCompanyIngest redacts a bare JWT pasted into free text with no Bearer/token keyword (#1315)', () => {
  const result = gateCompanyIngest(`Wiki notu: oturum jetonu ${SAMPLE_JWT} ile test ettim`);

  assert.equal(result.secretDetected, true);
  assert.equal(result.text.includes(SAMPLE_JWT), false);
  assert.equal(result.text, 'Wiki notu: oturum jetonu [REDACTED_SECRET:jwt] ile test ettim');
});

test('gateCompanyIngest redacts a JWT that is the entire ingested value (#1315)', () => {
  const result = gateCompanyIngest(SAMPLE_JWT);

  assert.equal(result.secretDetected, true);
  assert.equal(result.text.includes(SAMPLE_JWT), false);
});

test('gateCompanyIngest leaves ordinary text untouched', () => {
  const result = gateCompanyIngest('kedi hayvandir ve 5 tane ayagi vardir');

  assert.equal(result.piiDetected, false);
  assert.equal(result.secretDetected, false);
  assert.equal(result.text, 'kedi hayvandir ve 5 tane ayagi vardir');
});
