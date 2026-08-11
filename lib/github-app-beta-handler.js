'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { verifyWebhookSignature } = require('./github-app-beta-auth');
const { GitHubAppStoreError } = require('./github-app-beta-store');
const {
  buildCanonicalReceiptPayload,
  sha256Hex,
} = require('./receipt/canonical-receipt');
const { appendReceiptToChain } = require('./receipt/receipt-chain');

const RECEIPT_KIND = 'github_app_beta_pull_request_observation';
const TRUST_POLICY_VERSION = 'v5-c7-github-app-beta-v1';
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SUPPORTED_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);

const ERROR_CODES = Object.freeze({
  INVALID_HEADERS: 'GITHUB_APP_INVALID_HEADERS',
  INVALID_SIGNATURE: 'GITHUB_APP_INVALID_SIGNATURE',
  PAYLOAD_TOO_LARGE: 'GITHUB_APP_PAYLOAD_TOO_LARGE',
  INVALID_JSON: 'GITHUB_APP_INVALID_JSON',
  UNSUPPORTED_EVENT: 'GITHUB_APP_UNSUPPORTED_EVENT',
  UNSUPPORTED_ACTION: 'GITHUB_APP_UNSUPPORTED_ACTION',
  INVALID_PAYLOAD: 'GITHUB_APP_INVALID_PAYLOAD',
  DELIVERY_STATE_UNKNOWN: 'GITHUB_APP_DELIVERY_STATE_UNKNOWN',
});

class GitHubAppBetaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubAppBetaError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GitHubAppBetaError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readHeader(headers, wanted) {
  if (!isPlainObject(headers)) fail(ERROR_CODES.INVALID_HEADERS, 'GitHub App webhook headers are invalid');
  const wantedLower = wanted.toLowerCase();
  const matches = [];
  for (const key of Reflect.ownKeys(headers)) {
    if (typeof key !== 'string') fail(ERROR_CODES.INVALID_HEADERS, 'GitHub App webhook headers are invalid');
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(ERROR_CODES.INVALID_HEADERS, 'GitHub App webhook headers are invalid');
    }
    if (key.toLowerCase() === wantedLower) matches.push(descriptor.value);
  }
  if (matches.length === 0) return '';
  if (matches.length !== 1) fail(ERROR_CODES.INVALID_HEADERS, 'GitHub App webhook header is ambiguous');
  const value = matches[0];
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== 'string') {
      fail(ERROR_CODES.INVALID_HEADERS, 'GitHub App webhook header is ambiguous');
    }
    return value[0];
  }
  if (typeof value !== 'string') fail(ERROR_CODES.INVALID_HEADERS, 'GitHub App webhook header is invalid');
  return value;
}

function payloadSha256(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalInstantFromMs(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'GitHub App beta clock is invalid');
  }
  return new Date(nowMs).toISOString();
}

function snapshotPullRequestPayload(payload) {
  if (!isPlainObject(payload)
      || !isPlainObject(payload.repository)
      || !isPlainObject(payload.pull_request)
      || !isPlainObject(payload.pull_request.head)
      || !isPlainObject(payload.installation)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'GitHub App pull request payload is incomplete');
  }
  const action = payload.action;
  if (typeof action !== 'string' || !SUPPORTED_ACTIONS.has(action)) {
    fail(ERROR_CODES.UNSUPPORTED_ACTION, 'GitHub App pull request action is not in the beta scope');
  }

  const repositoryId = payload.repository.id;
  const repositoryFullName = payload.repository.full_name;
  const installationId = payload.installation.id;
  const number = payload.number;
  const pullRequestNumber = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;

  if (!positiveInteger(repositoryId)
      || typeof repositoryFullName !== 'string'
      || repositoryFullName.length > 256
      || !/^[^/\s]+\/[^/\s]+$/.test(repositoryFullName)
      || !positiveInteger(installationId)
      || !positiveInteger(number)
      || number !== pullRequestNumber
      || typeof headSha !== 'string'
      || !SHA_PATTERN.test(headSha)) {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'GitHub App pull request identity is invalid');
  }

  return Object.freeze({
    action,
    repositoryId,
    repositoryFullName,
    installationId,
    pullRequestNumber: number,
    headSha,
  });
}

function buildReceipt(binding, action) {
  const receiptId = `github_app_beta_receipt_${sha256Hex(binding.deliveryId)}`;
  const canonicalPayload = buildCanonicalReceiptPayload({
    receiptId,
    receiptKind: RECEIPT_KIND,
    decision: 'beta_observation_only',
    status: 'observed',
    admissionId: `github_app_delivery:${binding.deliveryId}`,
    workspaceId: 'default',
    actor: `github-app:${binding.installationId}`,
    agentId: `github-app:${binding.installationId}`,
    provenanceId: `github-app-delivery:${binding.deliveryId}`,
    trustPolicyVersion: TRUST_POLICY_VERSION,
    approvalStatus: 'pending',
    reason: 'github_app_beta_observation_requires_review',
    createdAt: binding.reservedAt,
    metadata: {
      event: binding.event,
      action,
      repositoryId: binding.repositoryId,
      repositoryFullName: binding.repositoryFullName,
      installationId: binding.installationId,
      pullRequestNumber: binding.pullRequestNumber,
      headSha: binding.headSha,
      payloadSha256: binding.payloadSha256,
    },
  }, { verdict: 'review' });
  return appendReceiptToChain(canonicalPayload);
}

function mapStoreError(error) {
  if (!(error instanceof GitHubAppStoreError)) throw error;
  if (error.code === 'GITHUB_APP_DELIVERY_STATE_UNKNOWN') {
    fail(ERROR_CODES.DELIVERY_STATE_UNKNOWN, 'GitHub App delivery state is unknown');
  }
  throw error;
}

function handleGitHubAppPullRequestWebhook({
  headers,
  rawBody,
  webhookSecret,
  store,
  nowMs = Date.now(),
}) {
  if (!Buffer.isBuffer(rawBody)) fail(ERROR_CODES.INVALID_JSON, 'GitHub App webhook body must be raw bytes');
  if (rawBody.length === 0 || rawBody.length > MAX_WEBHOOK_BYTES) {
    fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'GitHub App webhook payload is outside the beta size bound');
  }
  if (!store || typeof store.reserveDelivery !== 'function' || typeof store.commitReceipt !== 'function') {
    fail(ERROR_CODES.INVALID_PAYLOAD, 'GitHub App beta store is unavailable');
  }

  const signature = readHeader(headers, 'x-hub-signature-256');
  if (!verifyWebhookSignature({ webhookSecret, rawBody, signature })) {
    fail(ERROR_CODES.INVALID_SIGNATURE, 'GitHub App webhook signature verification failed');
  }
  const event = readHeader(headers, 'x-github-event');
  if (event !== 'pull_request') {
    fail(ERROR_CODES.UNSUPPORTED_EVENT, 'GitHub App event is not in the beta scope');
  }
  const deliveryId = readHeader(headers, 'x-github-delivery');
  if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
    fail(ERROR_CODES.INVALID_HEADERS, 'GitHub App delivery GUID is invalid');
  }

  let payload;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    payload = JSON.parse(text);
  } catch (_) {
    fail(ERROR_CODES.INVALID_JSON, 'GitHub App webhook JSON is invalid');
  }
  const pr = snapshotPullRequestPayload(payload);
  const binding = Object.freeze({
    deliveryId: deliveryId.toLowerCase(),
    event,
    repositoryId: pr.repositoryId,
    repositoryFullName: pr.repositoryFullName,
    installationId: pr.installationId,
    pullRequestNumber: pr.pullRequestNumber,
    headSha: pr.headSha,
    payloadSha256: payloadSha256(rawBody),
    reservedAt: canonicalInstantFromMs(nowMs),
  });

  let reservation;
  try {
    reservation = store.reserveDelivery(binding);
  } catch (error) {
    mapStoreError(error);
  }
  if (reservation.state === 'complete') {
    return Object.freeze({ duplicate: true, receipt: reservation.receipt, binding: reservation.binding });
  }
  if (reservation.state === 'pending') {
    fail(ERROR_CODES.DELIVERY_STATE_UNKNOWN, 'GitHub App delivery is reserved without a committed receipt');
  }

  const receipt = buildReceipt(binding, pr.action);
  let committed;
  try {
    committed = store.commitReceipt(binding, receipt);
  } catch (error) {
    mapStoreError(error);
  }
  return Object.freeze({ duplicate: false, receipt: committed, binding });
}

module.exports = {
  RECEIPT_KIND,
  TRUST_POLICY_VERSION,
  MAX_WEBHOOK_BYTES,
  ERROR_CODES,
  GitHubAppBetaError,
  handleGitHubAppPullRequestWebhook,
};
