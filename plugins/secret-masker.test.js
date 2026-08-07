const test = require('node:test');
const assert = require('node:assert/strict');

const secretMasker = require('./secret-masker');
const { findSecretsInText, maskSecretsInText } = secretMasker;
const Kernel = require('../kernel');

test('secret-masker: finds an sk- style API key embedded in a sentence', () => {
  const findings = findSecretsInText('use sk-abcdef1234567890 to authenticate');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'api_key');
});

test('secret-masker: finds a Bearer token', () => {
  const findings = findSecretsInText('Authorization: Bearer abcXYZ123.456-789_ok');
  assert.equal(findings.some((f) => f.type === 'bearer_token'), true);
});

test('secret-masker: finds an AWS access key and a GitHub token', () => {
  assert.equal(findSecretsInText('key AKIAABCDEFGHIJKLMNOP here').some((f) => f.type === 'aws_access_key'), true);
  assert.equal(findSecretsInText('token ghp_abcdefghijklmnopqrstuvwxyz0123').some((f) => f.type === 'github_token'), true);
});

test('secret-masker: finds a PEM private key block', () => {
  const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----';
  const findings = findSecretsInText(text);
  assert.equal(findings.some((f) => f.type === 'private_key_block'), true);
});

test('secret-masker: finds an assignment-shaped secret (label: value / label=value)', () => {
  assert.equal(findSecretsInText('password: hunter2isnotsafe').some((f) => f.type === 'assignment'), true);
  assert.equal(findSecretsInText('api_key=abcdef123456').some((f) => f.type === 'assignment'), true);
});

test('secret-masker: does NOT flag ordinary prose that merely mentions token/secret/password', () => {
  const findings = findSecretsInText('OAuth token nedir? Bir token, kimlik doğrulama için kullanılan bir değerdir.');
  assert.equal(findings.length, 0, `expected no findings, got: ${JSON.stringify(findings)}`);
});

test('secret-masker: maskSecretsInText replaces matches and preserves surrounding text', () => {
  const masked = maskSecretsInText('the key is sk-abcdef1234567890 for now');
  assert.equal(masked.includes('sk-abcdef1234567890'), false);
  assert.equal(masked.startsWith('the key is [REDACTED_SECRET:api_key]'), true);
  assert.equal(masked.endsWith('for now'), true);
});

test('secret-masker: maskSecretsInText is a no-op on text with no secrets', () => {
  const text = 'Köpek hayvandır ve havlar.';
  assert.equal(maskSecretsInText(text), text);
});

test('secret-masker: afterDream masks hypothesis text in place', () => {
  const data = {
    hypotheses: [
      { type: 'benzer', text: 'a ve b benzer, ama sk-abcdef1234567890 sızmış' },
      { type: 'boşluk', text: 'c bağlantısız' },
    ],
  };
  secretMasker.afterDream(null, data);
  assert.equal(data.hypotheses[0].text.includes('sk-abcdef1234567890'), false);
  assert.equal(data.hypotheses[0].text.includes('[REDACTED_SECRET:api_key]'), true);
  assert.equal(data.hypotheses[1].text, 'c bağlantısız');
});

test('secret-masker: afterAsk end to end -- a leaked secret never reaches kernel.ask()\'s caller', () => {
  // A plugin registered before secret-masker appends a secret to the
  // answer; secret-masker (registered after) must redact it before
  // kernel-read-use-cases.js's real ask() call site returns the result --
  // this exercises the actual production afterAsk wiring, not the plugin
  // in isolation.
  const leaker = {
    name: 'leaker-test',
    requires: [],
    optional: [],
    afterAsk(kernel, data) {
      data.answer = `${data.answer} debug: sk-abcdef1234567890`;
    },
  };
  // loadPlugins: false so this test controls registration order itself --
  // otherwise the real plugins/ directory (including secret-masker.js
  // auto-loaded from disk) registers before `leaker` here, and afterAsk
  // handlers run in registration order, so the auto-loaded masker would
  // run before the leak is even introduced.
  const k2 = new Kernel({ noLoad: true, loadPlugins: false });
  k2.plugins.register(leaker);
  k2.plugins.register(secretMasker);
  k2.learn('Köpek hayvandır', Kernel.createAdmissionBypassOpts('test'));
  const answer = k2.ask('Köpek nedir').data.answer;

  assert.equal(answer.includes('sk-abcdef1234567890'), false);
  assert.equal(answer.includes('[REDACTED_SECRET:api_key]'), true);
  assert.ok(answer.includes('hayvan'), 'legitimate answer content should survive masking');
});
