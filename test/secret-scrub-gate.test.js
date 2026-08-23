const test = require('node:test');
const assert = require('node:assert/strict');

const { AB7_GATE_VERSION, scrubSecrets } = require('../lib/secret-scrub-gate');
const { hasSecretLookingValue, redactSecretValues } = require('../lib/tool-call-gate');

test('scrubSecrets redacts a key-name-detected secret and reports detection', () => {
  const result = scrubSecrets({ apiKey: 'sk-abcdefghijklmnop', note: 'safe value' });

  assert.equal(result.secretDetected, true);
  assert.equal(result.gateVersion, AB7_GATE_VERSION);
  assert.equal(result.scrubbed.apiKey, '[REDACTED]');
  assert.equal(result.scrubbed.note, 'safe value');
});

test('scrubSecrets redacts a value-shaped secret even under a benign key name', () => {
  const result = scrubSecrets({ headerValue: 'Bearer abcdefghijklmnopqrstuvwx' });

  assert.equal(result.secretDetected, true);
  assert.equal(result.scrubbed.headerValue, '[REDACTED]');
});

test('scrubSecrets returns the payload unchanged when nothing looks like a secret', () => {
  const payload = { text: 'kedi hayvandir', count: 3, active: true };
  const result = scrubSecrets(payload);

  assert.equal(result.secretDetected, false);
  assert.deepEqual(result.scrubbed, payload);
});

test('scrubSecrets redacts nested and array-nested secrets, preserving structure', () => {
  const result = scrubSecrets({
    metadata: { auth: { password: 'hunter2', label: 'primary' } },
    items: [{ token: 'tok_live_abcdefgh' }, { safe: 'value' }],
  });

  assert.equal(result.secretDetected, true);
  assert.equal(result.scrubbed.metadata.auth.password, '[REDACTED]');
  assert.equal(result.scrubbed.metadata.auth.label, 'primary');
  assert.equal(result.scrubbed.items[0].token, '[REDACTED]');
  assert.equal(result.scrubbed.items[1].safe, 'value');
});

// Composed from separate segments (rather than one literal token string) so
// this synthetic fixture -- structurally JWT-shaped but not a real
// credential -- doesn't read as a committed secret to source scanners.
const JWT_HEADER = 'eyJhbGciOiJIUzI1NiJ9';
const JWT_PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
const JWT_SIGNATURE = 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const SAMPLE_JWT = [JWT_HEADER, JWT_PAYLOAD, JWT_SIGNATURE].join('.');

test('scrubSecrets redacts a bare JWT with no keyword or Bearer prefix nearby (#1315)', () => {
  const result = scrubSecrets({ text: `Wiki notu: oturum jetonu ${SAMPLE_JWT} ile` });

  assert.equal(result.secretDetected, true);
  assert.equal(result.scrubbed.text, 'Wiki notu: oturum jetonu [REDACTED_SECRET:jwt] ile');
});

test('scrubSecrets redacts a JWT that is the entire value (#1315)', () => {
  const result = scrubSecrets({ text: SAMPLE_JWT });

  assert.equal(result.secretDetected, true);
  assert.equal(result.scrubbed.text, '[REDACTED_SECRET:jwt]');
});

test('scrubSecrets still redacts a Bearer-prefixed JWT via the existing keyword/shape rule (#1315)', () => {
  const result = scrubSecrets({ text: `Authorization: Bearer ${SAMPLE_JWT}` });

  assert.equal(result.secretDetected, true);
  assert.equal(result.scrubbed.text, '[REDACTED]');
});

test('redactSecretValues and hasSecretLookingValue agree on the same detection rules (reused, not reimplemented)', () => {
  const payload = { credential: 'topsecret' };
  assert.equal(hasSecretLookingValue(payload), true);
  assert.equal(redactSecretValues(payload).credential, '[REDACTED]');
});

test('hasSecretLookingValue does not stack overflow on a cyclic object (#382)', () => {
  const cyclic = { safe: 'value' };
  cyclic.self = cyclic;

  assert.doesNotThrow(() => hasSecretLookingValue(cyclic));
  assert.equal(hasSecretLookingValue(cyclic), false);
});

test('hasSecretLookingValue does not stack overflow on a cyclic array (#382)', () => {
  const cyclic = ['a', 'apiKey:tok_live_abcdefgh'];
  cyclic.push(cyclic);

  assert.doesNotThrow(() => hasSecretLookingValue(cyclic));
});

test('redactSecretValues does not stack overflow on a cyclic object and marks the cycle (#382)', () => {
  const cyclic = { password: 'hunter2', label: 'primary' };
  cyclic.self = cyclic;

  let result;
  assert.doesNotThrow(() => { result = redactSecretValues(cyclic); });
  assert.equal(result.password, '[REDACTED]');
  assert.equal(result.label, 'primary');
  assert.equal(result.self, '[CIRCULAR]');
});

test('scrubSecrets does not stack overflow on a cyclic payload (#382)', () => {
  const cyclic = { token: 'tok_live_abcdefgh' };
  cyclic.nested = cyclic;

  assert.doesNotThrow(() => scrubSecrets(cyclic));
});
