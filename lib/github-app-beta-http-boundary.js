'use strict';

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
  verifyWebhookSignature,
} = require('./github-app-beta-auth');
const {
  GitHubAppStoreError,
  createGitHubAppBetaStore,
} = require('./github-app-beta-store');

const GITHUB_APP_BETA_PATH = '/api/github-app/webhook';
const GITHUB_APP_BETA_ENABLE_ENV = 'GITHUB_APP_BETA_ENABLED';
const GITHUB_APP_WEBHOOK_SECRET_ENV = 'GITHUB_APP_WEBHOOK_SECRET';
const GITHUB_APP_STORE_PATH_ENV = 'GITHUB_APP_STORE_PATH';
const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

function failConfig() {
  const error = new Error('GitHub App beta production configuration is invalid');
  error.code = 'GITHUB_APP_BETA_CONFIG_INVALID';
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
  return descriptor(500, { ok: false, error: { code: 'GITHUB_APP_BETA_INTERNAL_ERROR' } });
}

function createGitHubAppBetaHttpBoundary(options = {}) {
  const environment = options.environment || process.env;
  const enabled = readCompatibleEnvironmentVariable(GITHUB_APP_BETA_ENABLE_ENV, environment);
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') failConfig();

  const webhookSecret = readCompatibleEnvironmentVariable(GITHUB_APP_WEBHOOK_SECRET_ENV, environment);
  const storePath = readCompatibleEnvironmentVariable(GITHUB_APP_STORE_PATH_ENV, environment);
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0
      || typeof storePath !== 'string' || storePath.length === 0) failConfig();

  const store = createGitHubAppBetaStore({ rootPath: storePath });

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
  createGitHubAppBetaHttpBoundary,
});
