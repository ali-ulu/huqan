'use strict';

// #2231: error-to-HTTP mapping extracted from github-app-beta-http-boundary.
// One job: translate domain/store/streaming errors into frozen response
// descriptors. No I/O, no config, no request parsing.
//
// The 503/409 design note lives with the code it constrains: Streaming Trust
// answers 409 (never 503) on ambiguous writeback because a redelivery can
// only fail the same way again, and 200-declined for refusals already
// recorded on the pull request as a declined check run.

const {
  GitHubAppBetaError,
} = require('./github-app-beta-handler');
const {
  GitHubAppAuthError,
} = require('./github-app-beta-auth');
const {
  GitHubAppStoreError,
} = require('./github-app-beta-store');
const {
  ERROR_CODES: STREAMING_ERROR_CODES,
  GitHubAppStreamingTrustError,
} = require('./github-app-streaming-trust');
const {
  GitHubAppStreamingStoreError,
} = require('./github-app-streaming-trust-store');
const { descriptor } = require('./github-app-beta-http-responses');

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

module.exports = Object.freeze({
  STREAMING_DECLINED_STATUSES,
  STREAMING_CONFLICT_STATUSES,
  mapError,
});
