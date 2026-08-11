'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  ERROR_CODES,
  createGitHubAppJwt,
  createInstallationAccessToken,
  verifyWebhookSignature,
} = require('../lib/github-app-beta-auth');

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

test('webhook verification accepts only the exact HMAC-SHA256 over raw bytes', () => {
  const webhookSecret = 'beta-secret-123';
  const rawBody = Buffer.from('{"message":"şüpheli değil"}', 'utf8');
  const signature = `sha256=${crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`;
  assert.equal(verifyWebhookSignature({ webhookSecret, rawBody, signature }), true);
  assert.equal(verifyWebhookSignature({ webhookSecret, rawBody: Buffer.from('{}'), signature }), false);
  assert.equal(verifyWebhookSignature({ webhookSecret, rawBody, signature: `${signature.slice(0, -1)}0` }), false);
  assert.equal(verifyWebhookSignature({ webhookSecret, rawBody, signature: 'sha1=deadbeef' }), false);
});

test('webhook verification rejects missing secrets without disclosing values', () => {
  assert.throws(
    () => verifyWebhookSignature({ webhookSecret: '', rawBody: Buffer.from('{}'), signature: '' }),
    (error) => error.code === ERROR_CODES.INVALID_WEBHOOK_SECRET && !error.message.includes('beta-secret'),
  );
});

test('GitHub App JWT is RS256, bounded in time, and verifiable by the paired public key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const nowMs = Date.parse('2026-08-11T14:30:00.000Z');
  const jwt = createGitHubAppJwt({ appId: 123456, privateKey, nowMs });
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
  assert.deepEqual(decodePart(encodedHeader), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decodePart(encodedPayload), {
    iat: Math.floor(nowMs / 1000) - 60,
    exp: Math.floor(nowMs / 1000) + 540,
    iss: '123456',
  });
  assert.equal(
    crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
      publicKey,
      Buffer.from(encodedSignature, 'base64url'),
    ),
    true,
  );
});

test('installation token request is repository-scoped, permission-minimized, and token-shape agnostic', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let observed;
  const fetchImpl = async (url, options) => {
    observed = { url, options };
    return {
      ok: true,
      async json() {
        return {
          token: 'ghs_123456789_json-web-token-shaped-value',
          expires_at: '2026-08-11T15:00:00.000Z',
        };
      },
    };
  };
  const result = await createInstallationAccessToken({
    appId: 123456,
    privateKey,
    installationId: 98765,
    repositoryId: 1300995136,
    nowMs: Date.parse('2026-08-11T14:30:00.000Z'),
    fetchImpl,
  });
  assert.equal(result.token, 'ghs_123456789_json-web-token-shaped-value');
  assert.equal(observed.url, 'https://api.github.com/app/installations/98765/access_tokens');
  assert.equal(observed.options.method, 'POST');
  assert.match(observed.options.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.deepEqual(JSON.parse(observed.options.body), {
    repository_ids: [1300995136],
    permissions: { checks: 'write' },
  });
});

test('installation token failures are fail-closed and never echo credentials', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(
    () => createInstallationAccessToken({
      appId: 123456,
      privateKey,
      installationId: 98765,
      repositoryId: 1300995136,
      fetchImpl: async () => ({ ok: false, status: 401, async json() { return { token: 'leak-me' }; } }),
    }),
    (error) => error.code === ERROR_CODES.TOKEN_REQUEST_FAILED && !error.message.includes('leak-me'),
  );
});
