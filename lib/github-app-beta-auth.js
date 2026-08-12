'use strict';

const crypto = require('node:crypto');

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const SIGNATURE_PREFIX = 'sha256=';
const SIGNATURE_HEX = /^[0-9a-f]{64}$/;
const MAX_WEBHOOK_SECRET_BYTES = 4096;

const ERROR_CODES = Object.freeze({
  INVALID_WEBHOOK_SECRET: 'GITHUB_APP_INVALID_WEBHOOK_SECRET',
  INVALID_WEBHOOK_SIGNATURE: 'GITHUB_APP_INVALID_WEBHOOK_SIGNATURE',
  INVALID_APP_ID: 'GITHUB_APP_INVALID_APP_ID',
  INVALID_PRIVATE_KEY: 'GITHUB_APP_INVALID_PRIVATE_KEY',
  INVALID_INSTALLATION_ID: 'GITHUB_APP_INVALID_INSTALLATION_ID',
  INVALID_REPOSITORY_ID: 'GITHUB_APP_INVALID_REPOSITORY_ID',
  TOKEN_REQUEST_FAILED: 'GITHUB_APP_TOKEN_REQUEST_FAILED',
  TOKEN_RESPONSE_INVALID: 'GITHUB_APP_TOKEN_RESPONSE_INVALID',
});

class GitHubAppAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubAppAuthError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GitHubAppAuthError(code, message);
}

function nonEmptyString(value, maxLength = 4096) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value;
}

/**
 * The single source of truth for whether a webhook secret is usable (#646).
 *
 * verifyWebhookSignature() below refuses a secret that is empty, oversized, or
 * carries leading/trailing whitespace, so a secret failing this predicate can
 * never authenticate a delivery. The production boundary used to apply its own
 * looser rule at startup -- string and non-empty -- which let a secret like
 * '   ' or 'secret\n' start a server that then rejected every genuine GitHub
 * delivery with a 401. Config validation now calls this instead of restating
 * the rule, so the two layers cannot drift apart again.
 *
 * Note the deliberate absence of a trim: a secret with stray whitespace is
 * rejected, never silently repaired. Trimming would make the running service
 * authenticate against a value the operator never configured.
 */
function isValidWebhookSecret(value) {
  return nonEmptyString(value, MAX_WEBHOOK_SECRET_BYTES);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function snapshotPrivateKey(value) {
  try {
    const key = value instanceof crypto.KeyObject ? value : crypto.createPrivateKey(value);
    if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') {
      fail(ERROR_CODES.INVALID_PRIVATE_KEY, 'GitHub App private key must be an RSA private key');
    }
    return key;
  } catch (error) {
    if (error instanceof GitHubAppAuthError) throw error;
    fail(ERROR_CODES.INVALID_PRIVATE_KEY, 'GitHub App private key is invalid');
  }
}

function verifyWebhookSignature({ webhookSecret, rawBody, signature }) {
  if (!nonEmptyString(webhookSecret, MAX_WEBHOOK_SECRET_BYTES)) {
    fail(ERROR_CODES.INVALID_WEBHOOK_SECRET, 'GitHub App webhook secret is invalid');
  }
  if (!Buffer.isBuffer(rawBody)) {
    fail(ERROR_CODES.INVALID_WEBHOOK_SIGNATURE, 'GitHub App webhook body must be raw bytes');
  }
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return false;
  const suppliedHex = signature.slice(SIGNATURE_PREFIX.length);
  if (!SIGNATURE_HEX.test(suppliedHex)) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function createGitHubAppJwt({ appId, privateKey, nowMs = Date.now() }) {
  const normalizedAppId = typeof appId === 'string' ? appId : String(appId || '');
  if (!/^\d+$/.test(normalizedAppId) || normalizedAppId === '0') {
    fail(ERROR_CODES.INVALID_APP_ID, 'GitHub App ID is invalid');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail(ERROR_CODES.INVALID_APP_ID, 'GitHub App JWT clock is invalid');
  }
  const key = snapshotPrivateKey(privateKey);
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + (9 * 60),
    iss: normalizedAppId,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function createInstallationAccessToken({
  appId,
  privateKey,
  installationId,
  repositoryId,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
}) {
  if (!positiveSafeInteger(installationId)) {
    fail(ERROR_CODES.INVALID_INSTALLATION_ID, 'GitHub App installation ID is invalid');
  }
  if (!positiveSafeInteger(repositoryId)) {
    fail(ERROR_CODES.INVALID_REPOSITORY_ID, 'GitHub App repository ID is invalid');
  }
  if (typeof fetchImpl !== 'function') {
    fail(ERROR_CODES.TOKEN_REQUEST_FAILED, 'GitHub App installation token fetch is unavailable');
  }

  const jwt = createGitHubAppJwt({ appId, privateKey, nowMs });
  let response;
  try {
    response = await fetchImpl(
      `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': 'huqan-github-app-beta',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repository_ids: [repositoryId],
          permissions: { checks: 'write' },
        }),
      },
    );
  } catch (_) {
    fail(ERROR_CODES.TOKEN_REQUEST_FAILED, 'GitHub App installation token request failed');
  }

  if (!response || response.ok !== true || typeof response.json !== 'function') {
    fail(ERROR_CODES.TOKEN_REQUEST_FAILED, 'GitHub App installation token request was rejected');
  }
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    fail(ERROR_CODES.TOKEN_RESPONSE_INVALID, 'GitHub App installation token response is invalid');
  }
  if (!payload || typeof payload !== 'object'
      || !nonEmptyString(payload.token, 4096)
      || !nonEmptyString(payload.expires_at, 128)) {
    fail(ERROR_CODES.TOKEN_RESPONSE_INVALID, 'GitHub App installation token response is invalid');
  }
  const expiresMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    fail(ERROR_CODES.TOKEN_RESPONSE_INVALID, 'GitHub App installation token expiry is invalid');
  }
  return Object.freeze({ token: payload.token, expiresAt: payload.expires_at });
}

module.exports = {
  GITHUB_API_VERSION,
  ERROR_CODES,
  GitHubAppAuthError,
  isValidWebhookSecret,
  verifyWebhookSignature,
  createGitHubAppJwt,
  createInstallationAccessToken,
};
