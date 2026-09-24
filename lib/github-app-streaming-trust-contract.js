'use strict';

// #2167: the Streaming Trust contract -- API base, receipt kind, policy
// version, file and size bounds, patterns and error codes.

const GITHUB_API_BASE = 'https://api.github.com';
const RECEIPT_KIND = 'github_app_streaming_trust_code_change';
const TRUST_POLICY_VERSION = 'v5-c8-streaming-trust-v1';
const CHECK_NAME = 'HUQAN Streaming Trust';
const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 3;
const MAX_FILES = 200;
const MAX_PATH_BYTES = 1024;
const MAX_TOTAL_CHANGES = 1000000;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);

const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'GITHUB_APP_STREAMING_INVALID_INPUT',
  PR_READ_FAILED: 'GITHUB_APP_STREAMING_PR_READ_FAILED',
  PR_RESPONSE_INVALID: 'GITHUB_APP_STREAMING_PR_RESPONSE_INVALID',
  HEAD_DRIFT: 'GITHUB_APP_STREAMING_HEAD_DRIFT',
  FILES_READ_FAILED: 'GITHUB_APP_STREAMING_FILES_READ_FAILED',
  FILES_RESPONSE_INVALID: 'GITHUB_APP_STREAMING_FILES_RESPONSE_INVALID',
  EVIDENCE_TOO_LARGE: 'GITHUB_APP_STREAMING_EVIDENCE_TOO_LARGE',
  WRITEBACK_FAILED: 'GITHUB_APP_STREAMING_WRITEBACK_FAILED',
  WRITEBACK_RESPONSE_INVALID: 'GITHUB_APP_STREAMING_WRITEBACK_RESPONSE_INVALID',
  WRITEBACK_STATE_UNKNOWN: 'GITHUB_APP_STREAMING_WRITEBACK_STATE_UNKNOWN',
  BUDGET_EXCEEDED: 'GITHUB_APP_STREAMING_BUDGET_EXCEEDED',
});

/**
 * How long the read-and-evaluate phase may take before it gives up on its own.
 *
 * GitHub gives a webhook delivery about ten seconds before it calls the
 * delivery failed. This loop makes up to five outbound calls before it has a
 * verdict -- a token, a pull request read, and up to three pages of changed
 * files -- so a slow GitHub API can push it past that window. Letting that
 * happen hands the decision to a timeout: the delivery is marked failed, a
 * redelivery arrives, and the same slow reads start again.
 *
 * Eight seconds instead, measured by this loop, leaves room to write the
 * refusal down and answer deterministically. Giving up is a decision made
 * here, with a check run to show for it, rather than a deadline expiring
 * somewhere neither side can see.
 */
const DEFAULT_BUDGET_MS = 8000;

class GitHubAppStreamingTrustError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubAppStreamingTrustError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GitHubAppStreamingTrustError(code, message);
}

module.exports = {
  CHECK_NAME,
  DEFAULT_BUDGET_MS,
  DELIVERY_ID_PATTERN,
  ERROR_CODES,
  FILES_PER_PAGE,
  FILE_STATUSES,
  GITHUB_API_BASE,
  GitHubAppStreamingTrustError,
  HASH_PATTERN,
  MAX_FILES,
  MAX_FILE_PAGES,
  MAX_PATH_BYTES,
  MAX_TOTAL_CHANGES,
  RECEIPT_KIND,
  SHA_PATTERN,
  TRUST_POLICY_VERSION,
  fail,
};
