'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../lib/secret-patterns');
const secretMasker = require('../plugins/secret-masker');
const { hasSecretLookingValue } = require('../lib/tool-call-gate');

const JWT = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxIn0',
  'signatureExampleValue',
].join('.');

const PROVIDER_FIXTURES = Object.freeze([
  ['openai_project', ['sk', 'proj', 'ExampleValueNotARealCredential0123456789'].join('-')],
  ['github_classic', `ghp_${'a'.repeat(36)}`],
  ['github_fine_grained', `github_pat_${'a'.repeat(40)}`],
  ['aws_access', `ASIA${'A'.repeat(16)}`],
  ['aws_secret', ['wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY'].join('')],
  ['slack_bot', `xoxb-${'1'.repeat(10)}-${'2'.repeat(10)}-${'a'.repeat(24)}`],
  ['jwt', JWT],
  ['stripe_live', ['sk', 'live', 'a'.repeat(24)].join('_')],
  ['google_api', `AIzaSy${'A'.repeat(33)}`],
]);

test('plugin and security gates use the same shared detector functions (#1109)', () => {
  assert.equal(secretMasker.findSecretsInText, shared.findSecretsInText);
  assert.equal(secretMasker.maskSecretsInText, shared.maskSecretsInText);
});

test('shared detector covers provider credentials under neutral field names (#1109)', () => {
  for (const [label, credential] of PROVIDER_FIXTURES) {
    const findings = shared.findSecretsInText(`prefix ${credential} suffix`);
    assert.ok(findings.length > 0, label);
    assert.equal(hasSecretLookingValue({ note: credential }), true, label);
    assert.equal(shared.maskSecretsInText(credential).includes(credential), false, label);
  }
});

test('shared detector preserves ordinary prose and non-secret opaque values (#1109)', () => {
  const values = [
    'The web-application-server is running.',
    'OAuth token nedir?',
    'A'.repeat(40),
    'ordinary/path/withWordsAndNoCredentialShape',
  ];
  for (const value of values) {
    assert.deepEqual(shared.findSecretsInText(value), [], value);
  }
  for (const value of [values[0], values[2]]) {
    assert.equal(hasSecretLookingValue({ note: value }), false, value);
  }
});
