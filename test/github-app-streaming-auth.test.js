'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createStreamingTrustAccessToken } = require('../lib/github-app-streaming-auth');
const { GitHubAppAuthError } = require('../lib/github-app-beta-auth');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const okFetch = (captured) => async (url, init) => {
  if (captured) captured.push({ url, init });
  return {
    ok: true,
    json: async () => ({ token: 'ghs_token_value', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
  };
};

const failCode = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GitHubAppAuthError, `expected GitHubAppAuthError, got ${error?.constructor?.name}`);
    return error.code;
  }
  assert.fail('expected the call to fail closed');
};

const validIds = { appId: '1', privateKey, installationId: 42, repositoryId: 7, nowMs: 1_700_000_000_000 };

test('a valid installation token request scopes the grant to one repository and least permissions', async () => {
  const captured = [];
  const result = await createStreamingTrustAccessToken({ ...validIds, fetchImpl: okFetch(captured) });
  assert.deepEqual(result, { token: 'ghs_token_value', expiresAt: result.expiresAt });
  assert.ok(Object.isFrozen(result));
  const { url, init } = captured[0];
  assert.match(url, /\/app\/installations\/42\/access_tokens$/);
  assert.match(init.headers.Authorization, /^Bearer /);
  assert.deepEqual(JSON.parse(init.body), {
    repository_ids: [7],
    permissions: { checks: 'write', pull_requests: 'read' },
  });
});

test('installation and repository identifiers fail closed unless they are positive safe integers', async () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '42', null, undefined]) {
    assert.equal(await failCode(createStreamingTrustAccessToken({ ...validIds, fetchImpl: okFetch(), installationId: bad })),
      'GITHUB_APP_TOKEN_REQUEST_FAILED', `installationId=${String(bad)}`);
    assert.equal(await failCode(createStreamingTrustAccessToken({ ...validIds, fetchImpl: okFetch(), repositoryId: bad })),
      'GITHUB_APP_TOKEN_REQUEST_FAILED', `repositoryId=${String(bad)}`);
  }
});

test('a missing or non-callable fetch implementation fails closed', async () => {
  assert.equal(await failCode(createStreamingTrustAccessToken({ ...validIds, fetchImpl: undefined })),
    'GITHUB_APP_TOKEN_REQUEST_FAILED');
  assert.equal(await failCode(createStreamingTrustAccessToken({ ...validIds, fetchImpl: 'fetch' })),
    'GITHUB_APP_TOKEN_REQUEST_FAILED');
});

test('network failures, rejections, and malformed payloads never leak a token', async () => {
  assert.equal(await failCode(createStreamingTrustAccessToken({ ...validIds, fetchImpl: async () => { throw new Error('dns'); } })),
    'GITHUB_APP_TOKEN_REQUEST_FAILED');

  assert.equal(await failCode(createStreamingTrustAccessToken({
    ...validIds,
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  })), 'GITHUB_APP_TOKEN_REQUEST_FAILED');

  const payloadCases = [
    {},
    { token: 't' },
    { token: 't', expires_at: 'nope' },
    { token: '', expires_at: new Date(Date.now() + 1000).toISOString() },
    { token: 't'.repeat(4097), expires_at: new Date(Date.now() + 1000).toISOString() },
    { token: 't', expires_at: new Date(1_700_000_000_000 - 1).toISOString() },
  ];
  for (const payload of payloadCases) {
    assert.equal(await failCode(createStreamingTrustAccessToken({
      ...validIds,
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    })), 'GITHUB_APP_TOKEN_REQUEST_FAILED', `payload=${JSON.stringify(payload).slice(0, 40)}`);
  }
});
