'use strict';

const {
  handleGitHubAppPullRequestWebhook,
} = require('./github-app-beta-handler');
const {
  verifyWebhookSignature,
} = require('./github-app-beta-auth');
const {
  createGitHubAppBetaStore,
} = require('./github-app-beta-store');
const {
  handleGitHubAppStreamingTrustWebhook,
} = require('./github-app-streaming-trust-handler');
const {
  descriptor,
  requestHeaders,
  singleHeader,
  readRawBody,
} = require('./github-app-beta-http-responses');
const { mapError } = require('./github-app-beta-http-errors');
const {
  GITHUB_APP_BETA_ENABLE_ENV,
  GITHUB_APP_WEBHOOK_SECRET_ENV,
  GITHUB_APP_STORE_PATH_ENV,
  GITHUB_APP_STREAMING_TRUST_ENABLE_ENV,
  GITHUB_APP_ID_ENV,
  GITHUB_APP_PRIVATE_KEY_PATH_ENV,
  readStreamingTrustConfig,
  readBetaConfig,
} = require('./github-app-beta-http-config');

const GITHUB_APP_BETA_PATH = '/api/github-app/webhook';

function createGitHubAppBetaHttpBoundary(options = {}) {
  const environment = options.environment || process.env;
  const beta = readBetaConfig(environment);
  if (beta === null) return null;

  const store = createGitHubAppBetaStore({ rootPath: beta.storePath });
  const streaming = readStreamingTrustConfig(environment, beta.storePath);
  // Same seam as `options.environment`: production reads the global, tests
  // supply the outbound transport. The inbound path is never stubbed.
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  async function handle(req) {
    if (!req || req.method !== 'POST') {
      return descriptor(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } }, { Allow: 'POST' });
    }
    const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return descriptor(415, { ok: false, error: { code: 'CONTENT_TYPE_REQUIRED' } });
    }

    const raw = await readRawBody(req);
    if (!raw.ok) {
      return descriptor(raw.status, {
        ok: false,
        error: { code: raw.status === 413 ? 'GITHUB_APP_PAYLOAD_TOO_LARGE' : 'GITHUB_APP_REQUEST_ERROR' },
      });
    }

    const headers = requestHeaders(req);
    const event = singleHeader(headers, 'x-github-event');
    if (event === 'ping') {
      const signature = singleHeader(headers, 'x-hub-signature-256');
      try {
        if (!verifyWebhookSignature({ webhookSecret: beta.webhookSecret, rawBody: raw.body, signature })) {
          return descriptor(401, { ok: false, error: { code: 'GITHUB_APP_INVALID_SIGNATURE' } });
        }
      } catch (error) {
        return mapError(error);
      }
      return descriptor(200, { ok: true, event: 'ping' });
    }

    try {
      if (streaming) {
        // One HMAC verification, on the raw bytes, in the same place it always
        // happened: the C7 handler this one delegates to. Streaming Trust adds
        // a stage after the observation, not a second door into it.
        const result = await handleGitHubAppStreamingTrustWebhook({
          headers,
          rawBody: raw.body,
          webhookSecret: beta.webhookSecret,
          c7Store: store,
          c8Store: streaming.store,
          appId: streaming.appId,
          privateKey: streaming.privateKey,
          fetchImpl,
        });
        return descriptor(200, {
          ok: true,
          evaluated: true,
          duplicate: result.trust.duplicate,
          receiptHash: result.observation.receipt.receiptHash,
          trust: {
            receiptHash: result.trust.receipt.receiptHash,
            verdict: result.trust.receipt.verdict,
            conclusion: result.trust.conclusion,
            checkRunId: result.trust.checkRunId,
          },
        });
      }

      const result = handleGitHubAppPullRequestWebhook({
        headers,
        rawBody: raw.body,
        webhookSecret: beta.webhookSecret,
        store,
      });
      return descriptor(200, {
        ok: true,
        duplicate: result.duplicate,
        receiptHash: result.receipt.receiptHash,
      });
    } catch (error) {
      return mapError(error);
    }
  }

  return Object.freeze({
    path: GITHUB_APP_BETA_PATH,
    method: 'POST',
    handle,
  });
}

module.exports = Object.freeze({
  GITHUB_APP_BETA_PATH,
  GITHUB_APP_BETA_ENABLE_ENV,
  GITHUB_APP_WEBHOOK_SECRET_ENV,
  GITHUB_APP_STORE_PATH_ENV,
  GITHUB_APP_STREAMING_TRUST_ENABLE_ENV,
  GITHUB_APP_ID_ENV,
  GITHUB_APP_PRIVATE_KEY_PATH_ENV,
  createGitHubAppBetaHttpBoundary,
});
