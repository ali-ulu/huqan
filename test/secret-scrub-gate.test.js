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

test('redactSecretValues and hasSecretLookingValue agree on the same detection rules (reused, not reimplemented)', () => {
  const payload = { credential: 'topsecret' };
  assert.equal(hasSecretLookingValue(payload), true);
  assert.equal(redactSecretValues(payload).credential, '[REDACTED]');
});
