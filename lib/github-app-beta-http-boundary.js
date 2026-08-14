'use strict';

const fs = require('node:fs');

const {
  readCompatibleEnvironmentVariable,
} = require('./environment-compat');
const {
  MAX_WEBHOOK_BYTES,
  GitHubAppBetaError,
  handleGitHubAppPullRequestWebhook,
} = require('./github-app-beta-handler');
const {
  GitHubAppAuthError,
  createGitHubAppJwt,
  isValidWebhookSecret,
  verifyWebhookSignature,
} = require('./github-app-beta-auth');
const {
  GitHubAppStoreError,
  createGitHubAppBetaStore,
} = require('./github-app-beta-store');
const {
  GitHubAppStreamingStoreError,
  createGitHubAppStreamingTrustStore,
} = require('./github-app-streaming-trust-store');
const {
  ERROR_CODES: STREAMING_ERROR_CODES,
  GitHubAppStreamingTrustError,
} = require('./github-app-streaming-trust');
const {
  handleGitHubAppStreamingTrustWebhook,
} = require('./github-app-streaming-trust-handler');

const GITHUB_APP_BETA_PATH = '/api/github-app/webhook';
const GITHUB_APP_BETA_ENABLE_ENV = 'GITHUB_APP_BETA_ENABLED';
const GITHUB_APP_WEBHOOK_SECRET_ENV = 'GITHUB_APP_WEBHOOK_SECRET';
const GITHUB_APP_STORE_PATH_ENV = 'GITHUB_APP_STORE_PATH';

// Streaming Trust is opted into separately, and deliberately so. The beta flag
// above starts a server that only observes: it verifies a signature, records a
// receipt, and answers. Streaming Trust writes check runs back to the pull
// request. Hanging an outbound mutation off a flag someone already set for an
// observer would mean a variable changed its meaning underneath whoever set it.
const GITHUB_APP_STREAMING_TRUST_ENABLE_ENV = 'GITHUB_APP_STREAMING_TRUST_ENABLED';
const GITHUB_APP_ID_ENV = 'GITHUB_APP_ID';
const GITHUB_APP_PRIVATE_KEY_PATH_ENV = 'GITHUB_APP_PRIVATE_KEY_PATH';
const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function failConfig(cause) {
  const error = new Error('GitHub App beta production configuration is invalid');
  error.code = 'GITHUB_APP_BETA_CONFIG_INVALID';
  // The message stays deliberately incurious -- it is a startup error that must
  // not print a key path or a secret. But swallowing the cause entirely means a
  // misconfiguration and a genuine bug in this file look identical from the
  // outside, which cost real debugging time while wiring #694. The cause is
  // attached, not formatted into the message.
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function descriptor(statusCode, body, extraHeaders = {}) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ ...JSON_HEADERS, ...extraHeaders }),
    body: Object.freeze(body),
  });
}

function requestHeaders(req) {
  const distinct = req && req.headersDistinct;
  if (distinct && typeof distinct === 'object' && !Array.isArray(distinct)) return distinct;
  const headers = req && req.headers;
  return headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};
}

function singleHeader(headers, name) {
  const value = headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.length === 1 && typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

async function readRawBody(req, maxBytes = MAX_WEBHOOK_BYTES) {
  const declared = Number(req?.headers?.['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413 };
  }

  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks, size) }));
    req.on('aborted', () => finish({ ok: false, status: 400 }));
    req.on('error', () => finish({ ok: false, status: 400 }));
  });
}

function mapError(error) {
  if (error instanceof GitHubAppBetaError) {
    if (error.code === 'GITHUB_APP_INVALID_SIGNATURE') {
      return descriptor(401, { ok: false, error: { code: error.code } });
    }
    if (error.code === 'GITHUB_APP_PAYLOAD_TOO_LARGE') {
      return descriptor(413, { ok: false, error: { code: error.code } });
    }
    if (error.code === 'GITHUB_APP_DELIVERY_STATE_UNKNOWN') {
      return descriptor(503, { ok: false, error: { code: error.code } }, { 'Retry-After': '5' });
    }
    return descriptor(400, { ok: false, error: { code: error.code } });
  }
  if (error instanceof GitHubAppAuthError) {
    return descriptor(401, { ok: false, error: { code: error.code } });
  }
  if (error instanceof GitHubAppStoreError) {
    if (error.code === 'GITHUB_APP_DELIVERY_CONFLICT') {
      return descriptor(409, { ok: false, error: { code: error.code } });
    }
    if (error.code === 'GITHUB_APP_DELIVERY_STATE_UNKNOWN') {
      return descriptor(503, { ok: false, error: { code: error.code } }, { 'Retry-After': '5' });
    }
    return descriptor(500, { ok: false, error: { code: error.code } });
  }
  // --- Streaming Trust ---------------------------------------------------
  //
  // Nothing here answers 503, and that is the whole design rather than a
  // preference. Two properties make a retryable answer the wrong one:
  //
  //   A refusal has already written an `action_required` check run, so the
  //   outcome of this delivery is on the pull request. Inviting a redelivery
  //   would record the same outcome a second time.
  //
  //   An ambiguous writeback is deliberately not replayable -- the store
  //   refuses the second write. Answering 503 there guarantees a redelivery
  //   that can only fail again the same way, which answers 503 again. That is
  //   the amplifier, and 409 is what stops it: a conflict a person resolves,
  //   not a delay GitHub retries through.
  if (error instanceof GitHubAppStreamingTrustError) {
    if (STREAMING_DECLINED_STATUSES.has(error.code)) {
      return descriptor(200, { ok: true, evaluated: false, declined: { code: error.code } });
    }
    if (STREAMING_CONFLICT_STATUSES.has(error.code)) {
      return descriptor(409, { ok: false, error: { code: error.code } });
    }
    return descriptor(400, { ok: false, error: { code: error.code } });
  }
  if (error instanceof GitHubAppStreamingStoreError) {
    if (error.code === 'GITHUB_APP_STREAMING_STORE_IO_FAILED') {
      return descriptor(500, { ok: false, error: { code: error.code } });
    }
    return descriptor(409, { ok: false, error: { code: error.code } });
  }
  return descriptor(500, { ok: false, error: { code: 'GITHUB_APP_BETA_INTERNAL_ERROR' } });
}

// Exactly the codes whose refusal reached the pull request as a declined check.
// The delivery was received, verified, decided and recorded; 200 says so.
const STREAMING_DECLINED_STATUSES = new Set([
  STREAMING_ERROR_CODES.HEAD_DRIFT,
  STREAMING_ERROR_CODES.EVIDENCE_TOO_LARGE,
  STREAMING_ERROR_CODES.BUDGET_EXCEEDED,
  STREAMING_ERROR_CODES.PR_READ_FAILED,
  STREAMING_ERROR_CODES.PR_RESPONSE_INVALID,
  STREAMING_ERROR_CODES.FILES_READ_FAILED,
  STREAMING_ERROR_CODES.FILES_RESPONSE_INVALID,
]);

// Writeback outcomes a redelivery cannot improve on, because replay after an
// ambiguous write is refused by design.
const STREAMING_CONFLICT_STATUSES = new Set([
  STREAMING_ERROR_CODES.WRITEBACK_FAILED,
  STREAMING_ERROR_CODES.WRITEBACK_RESPONSE_INVALID,
  STREAMING_ERROR_CODES.WRITEBACK_STATE_UNKNOWN,
]);

function readStreamingTrustConfig(environment, storePath) {
  const enabled = readCompatibleEnvironmentVariable(GITHUB_APP_STREAMING_TRUST_ENABLE_ENV, environment);
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') failConfig();

  const appId = readCompatibleEnvironmentVariable(GITHUB_APP_ID_ENV, environment);
  const privateKeyPath = readCompatibleEnvironmentVariable(GITHUB_APP_PRIVATE_KEY_PATH_ENV, environment);
  if (typeof appId !== 'string' || !/^[0-9]{1,20}$/.test(appId)
      || typeof privateKeyPath !== 'string' || privateKeyPath.length === 0) failConfig();

  let privateKey;
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch (error) {
    failConfig(error);
  }
  // Validated with the auth layer's own predicate rather than a rule restated
  // here, for the reason #646 records: a key the JWT path would refuse must
  // fail at startup, not on the first genuine delivery.
  try {
    createGitHubAppJwt({ appId, privateKey, nowMs: Date.now() });
  } catch (error) {
    failConfig(error);
  }

  return Object.freeze({
    appId,
    privateKey,
    // Same root as the observation store: the C8 store namespaces its own
    // records underneath it, and one configured path is one thing to get right.
    store: createGitHubAppStreamingTrustStore({ rootPath: storePath }),
  });
}

function createGitHubAppBetaHttpBoundary(options = {}) {
  const environment = options.environment || process.env;
  const enabled = readCompatibleEnvironmentVariable(GITHUB_APP_BETA_ENABLE_ENV, environment);
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') failConfig();

  const webhookSecret = readCompatibleEnvironmentVariable(GITHUB_APP_WEBHOOK_SECRET_ENV, environment);
  const storePath = readCompatibleEnvironmentVariable(GITHUB_APP_STORE_PATH_ENV, environment);
  // #646: the secret is validated with the auth layer's own predicate rather
  // than a restated rule here. A secret the HMAC path would refuse must fail
  // at startup, not on the first genuine delivery -- restating the rule is how
  // '   ' and 'secret\n' came to start a server that 401'd every webhook.
  if (!isValidWebhookSecret(webhookSecret)
      || typeof storePath !== 'string' || storePath.length === 0) failConfig();

  const store = createGitHubAppBetaStore({ rootPath: storePath });
  const streaming = readStreamingTrustConfig(environment, storePath);
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
        if (!verifyWebhookSignature({ webhookSecret, rawBody: raw.body, signature })) {
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
          webhookSecret,
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
        webhookSecret,
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
