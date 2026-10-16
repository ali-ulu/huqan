'use strict';

const {
  GITHUB_API_VERSION,
  GitHubAppAuthError,
  createGitHubAppJwt,
} = require('./github-app-beta-auth');

const GITHUB_API_BASE = 'https://api.github.com';

function fail(message) {
  const error = new GitHubAppAuthError('GITHUB_APP_TOKEN_REQUEST_FAILED', message);
  throw error;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

async function createStreamingTrustAccessToken({
  appId,
  privateKey,
  installationId,
  repositoryId,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  signal,
}) {
  if (!positiveSafeInteger(installationId) || !positiveSafeInteger(repositoryId)) {
    fail('Streaming Trust installation token scope is invalid');
  }
  if (typeof fetchImpl !== 'function') {
    fail('Streaming Trust installation token fetch is unavailable');
  }

  const jwt = createGitHubAppJwt({ appId, privateKey, nowMs });
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'huqan-streaming-trust',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: { checks: 'write', pull_requests: 'read' },
      }),
      signal,
    });
  } catch (_) {
    fail('Streaming Trust installation token request failed');
  }
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    fail('Streaming Trust installation token request was rejected');
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    fail('Streaming Trust installation token response is invalid');
  }
  if (!payload || typeof payload !== 'object'
      || typeof payload.token !== 'string' || payload.token.length === 0 || payload.token.length > 4096
      || typeof payload.expires_at !== 'string' || payload.expires_at.length === 0 || payload.expires_at.length > 128) {
    fail('Streaming Trust installation token response is invalid');
  }
  const expiresMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    fail('Streaming Trust installation token expiry is invalid');
  }
  return Object.freeze({ token: payload.token, expiresAt: payload.expires_at });
}

module.exports = {
  createStreamingTrustAccessToken,
};
