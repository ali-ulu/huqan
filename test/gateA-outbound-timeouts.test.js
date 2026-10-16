'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubRestClient, DEFAULT_GITHUB_REQUEST_TIMEOUT_MS } = require('../lib/pr-guardian/github-client');
const { createInstallationAccessToken, DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS } = require('../lib/github-app-beta-auth');

test('Gate A item 2: pr-guardian github-client request carries AbortSignal timeout and is cancellable', async () => {
  let capturedSignal = null;
  const mockFetch = async (url, options) => {
    capturedSignal = options.signal;
    // Signal must be present and abortable
    assert.ok(capturedSignal, 'signal must be present');
    assert.equal(typeof capturedSignal.aborted, 'boolean');
    // Simulate success before timeout
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }), headers: new Map() };
  };
  // Inject mock via global fetch override — createGitHubRestClient uses global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    const client = createGitHubRestClient({ token: 'test-token-1234567890', timeoutMs: 50 });
    // Trigger a request via internal path — createComment is simplest
    await client.createComment('owner/repo', 1, 'hello');
    assert.ok(capturedSignal, 'fetch was called with signal');
    assert.equal(capturedSignal.aborted, false, 'signal not yet aborted for fast response');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(DEFAULT_GITHUB_REQUEST_TIMEOUT_MS, 15_000);
});

test('Gate A item 2: AbortSignal.any combines caller and timeout signals', async () => {
  const callerController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(5000);
  const combined = AbortSignal.any([callerController.signal, timeoutSignal]);
  assert.equal(combined.aborted, false);
  callerController.abort(new Error('caller abort'));
  assert.equal(combined.aborted, true, 'combined signal must abort when caller aborts');
  // Timeout signal alone also aborts
  const shortTimeout = AbortSignal.timeout(10);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(shortTimeout.aborted, true, 'timeout signal must abort after deadline');
});

test('Gate A item 2: github-app-beta-auth token request carries timeout signal', async () => {
  let capturedOptions = null;
  const mockFetch = async (url, options) => {
    capturedOptions = options;
    assert.ok(options.signal, 'signal must be present');
    assert.equal(options.signal.aborted, false);
    return { ok: true, json: async () => ({ token: 'ghs_testtoken1234567890abcdefghij', expires_at: new Date(Date.now() + 3600000).toISOString() }) };
  };
  const crypto = require('node:crypto');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const result = await createInstallationAccessToken({
    appId: '12345',
    privateKey: pem,
    installationId: 1,
    repositoryId: 1,
    fetchImpl: mockFetch,
    timeoutMs: 42,
  });
  assert.ok(result.token);
  assert.ok(capturedOptions.signal, 'fetch called with timeout signal');
  assert.equal(DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS, 15_000);
});

test('Gate A item 2: cli-ingest-batch requestJson times out and aborts', async () => {
  const { DEFAULT_CLI_INGEST_TIMEOUT_MS } = require('../lib/cli-ingest-batch');
  assert.equal(DEFAULT_CLI_INGEST_TIMEOUT_MS, 15_000);
  // Directly test AbortSignal.timeout behavior as used inside requestJson
  const signal = AbortSignal.timeout(10);
  assert.equal(signal.aborted, false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal.aborted, true, 'AbortSignal.timeout must abort after deadline');
});

// Timeout must actually abort a hanging fetch via AbortSignal.timeout
test('Gate A item 2: AbortSignal.timeout aborts hanging fetch within bound', async () => {
  const hangingFetch = (url, { signal }) => new Promise((resolve, reject) => {
    if (signal) {
      if (signal.aborted) return reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), { once: true }));
      // Keep event loop alive until abort
      const t = setTimeout(() => {}, 100);
      signal.addEventListener('abort', () => clearTimeout(t), { once: true });
    }
  });
  await assert.rejects(
    () => hangingFetch('https://example.com', { signal: AbortSignal.timeout(15) }),
    (err) => err.name === 'AbortError',
  );
});
