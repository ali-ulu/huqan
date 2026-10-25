'use strict';

// #4244 (CWE-311): credentials with no keyword in them -- a URL's userinfo, an
// `Authorization: Basic` header, a named cookie pair, an unsigned JWT -- were
// not treated as secrets, so the MCP dry-run echo and the evidence pack carried
// them in the clear. Fixtures are composed at runtime (repo convention: no
// secret-like literal in source).

const test = require('node:test');
const assert = require('node:assert/strict');

const { findSecretsInText, maskSecretsInText } = require('../lib/secret-patterns');
const { redactSecretValuesWithTrace } = require('../lib/tool-call-gate-secrets');
const { scrubSecrets } = require('../lib/secret-scrub-gate');
const { createReadOnlyDryRun } = require('../lib/mcp/tool-handlers');

const PASSWORD = ['p4ss', 'w0rdExample'].join('');
const DSN = ['postgres', '://', 'app_user', ':', PASSWORD, '@db.internal:5432/huqan'].join('');
const FULL_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0In0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'].join('.');

function typesIn(text) {
  return findSecretsInText(text).map((finding) => finding.type);
}

test('a URL userinfo pair is a secret and only the credential part is masked', () => {
  assert.deepEqual(typesIn(DSN), ['url_userinfo']);
  const masked = maskSecretsInText(DSN);
  assert.equal(masked.includes(PASSWORD), false);
  assert.equal(masked, 'postgres://[REDACTED_SECRET:url_userinfo]@db.internal:5432/huqan');
});

test('an Authorization: Basic header is a secret', () => {
  const header = `Authorization: Basic ${Buffer.from('app_user:p4ssw0rd').toString('base64')}`;
  assert.deepEqual(typesIn(header), ['basic_auth']);
  const masked = maskSecretsInText(header);
  assert.equal(masked, 'Authorization: Basic [REDACTED_SECRET:basic_auth]');
  assert.deepEqual(typesIn(`Proxy-Authorization: Basic ${Buffer.from('app_user:otherPassword').toString('base64')}`), ['basic_auth']);
});

test('a named cookie pair in a header is a secret, a bare label is not', () => {
  const header = `Set-Cookie: sid=${'a1B2c3D4e5'.repeat(2)}; Path=/; HttpOnly`;
  assert.deepEqual(typesIn(header), ['cookie_header']);
  assert.equal(maskSecretsInText(header), '[REDACTED_SECRET:cookie_header]');
  assert.deepEqual(typesIn('Cookie: theme=dark'), []);
  assert.deepEqual(typesIn('Cookie: chocolate chip recipe'), []);
});

test('an unsigned or truncated JWT is a secret, a complete one keeps its own type', () => {
  const unsigned = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0';
  assert.deepEqual(typesIn(unsigned), ['jwt_like']);
  assert.equal(maskSecretsInText(unsigned), '[REDACTED_SECRET:jwt_like]');
  assert.deepEqual(typesIn(FULL_JWT), ['jwt']);
});

test('ordinary prose, plain URLs and version strings are still not secrets', () => {
  const clean = [
    'Connect to https://db.internal:5432/huqan for details.',
    'Basic authentication is enough for the local console.',
    'See https://example.com/path@anchor.',
    'huqan 1.2.3 is released.',
  ];
  for (const value of clean) assert.deepEqual(findSecretsInText(value), [], value);
});

test('the dry-run echo and the scrub gate both mask the new shapes', () => {
  const scrubbed = scrubSecrets({ args: { dsn: DSN } });
  assert.equal(scrubbed.secretDetected, true);
  assert.equal(JSON.stringify(scrubbed.scrubbed).includes(PASSWORD), false);

  const echo = createReadOnlyDryRun({ withTransientAgent: () => { throw new Error('dry run must not execute'); } });
  const preview = echo({}, 'huqan.status', { dsn: DSN });
  assert.equal(JSON.stringify(preview).includes(PASSWORD), false);
  assert.equal(JSON.stringify(preview).includes('url_userinfo'), true);
});

test('the redaction trace names the path and the shape, never the secret', () => {
  const { redacted, erased } = redactSecretValuesWithTrace({ note: `db is ${DSN} now` });
  assert.equal(redacted.note.includes(PASSWORD), false);
  assert.equal(redacted.note.includes('db.internal:5432/huqan'), true);
  assert.deepEqual(erased, [
    { path: 'note', rule: 'embedded_secret', types: [{ type: 'url_userinfo', count: 1 }] },
  ]);
});
