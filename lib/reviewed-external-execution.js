'use strict';

const { verifyExternalIngestApproval } = require('./external-ingest-approval');
const {
  EXTERNAL_INGEST_CONTEXT_SOURCE,
  EXTERNAL_INGEST_TOOL,
} = require('./external-ingest-queue');
const { sha256 } = require('./ingest');
const {
  IDEMPOTENCY_CONTEXT_KEY,
  IDEMPOTENCY_CONTEXT_VERSION,
} = require('./tool-approval-idempotency');

const REVIEWED_EXTERNAL_EXECUTION_VERSION = 'huqan.reviewed-external-execution.v1';
const CONTEXT_FIELDS = new Set([
  'source',
  'externalApproval',
  IDEMPOTENCY_CONTEXT_KEY,
  'executionClaim',
]);
const POLICY_FIELDS = new Set([
  'action',
  'approval',
  'snapshotIntegrity',
  'sourceAccess',
]);
const CLAIM_FIELDS = new Set(['owner', 'claimedAt', 'leaseExpiresAt']);

function failure(code, error) {
  return { ok: false, code, error };
}

function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => fields.has(key))
    && Object.keys(value).length === fields.size;
}

function boundedIdentity(value, code, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/u.test(text)) {
    return failure(code, `${label} is required and must be a bounded printable string`);
  }
  return { ok: true, value: text };
}

function nowMillis(value) {
  const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
  return Number.isFinite(date.getTime())
    ? { ok: true, value: date.getTime(), iso: date.toISOString() }
    : failure('REVIEWED_EXECUTION_NOW_INVALID', 'execution time is invalid');
}

function expectedInputSummary(approval) {
  return JSON.stringify({
    action: approval.payload.action,
    version: approval.version,
    sourceType: approval.sourceType,
    sourceRef: approval.sourceRef,
    immutableSourceId: approval.immutableSourceId,
    reviewedManifestHash: approval.reviewedManifestHash,
    snapshotHash: approval.snapshotHash,
    requester: approval.requester,
    workspaceId: approval.workspaceId,
    idempotencyKey: approval.idempotencyKey,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
  });
}

function deepCopyAndFreeze(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = item => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
    for (const nested of Object.values(item)) freeze(nested);
    return Object.freeze(item);
  };
  return freeze(copy);
}

function prepareReviewedExternalExecution(record, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return failure('REVIEWED_EXECUTION_RECORD_REQUIRED', 'a persisted approval record is required');
  }
  if (record.tool !== EXTERNAL_INGEST_TOOL) {
    return failure('REVIEWED_EXECUTION_TOOL_MISMATCH', 'approval tool is not reviewed external ingest');
  }
  // A reviewed entry is queued with decision 'review'; claiming it for execution
  // atomically moves it to status 'executing' with decision 'approved'
  // (storage.claimToolApprovalWithLease). Review authorization is therefore
  // asserted below by policy.approval === 'review', not by this lifecycle
  // column, which can never still read 'review' once the row is executing.
  if (record.status !== 'executing' || record.decision !== 'approved') {
    return failure('REVIEWED_EXECUTION_STATUS_INVALID', 'approval must be claimed and executing with the claim-consistent approved decision');
  }

  const approvalId = boundedIdentity(record.id, 'REVIEWED_EXECUTION_APPROVAL_ID_REQUIRED', 'approvalId');
  if (!approvalId.ok) return approvalId;
  const requester = boundedIdentity(options.requester, 'REVIEWED_EXECUTION_REQUESTER_REQUIRED', 'requester');
  if (!requester.ok) return requester;
  const workspaceId = boundedIdentity(options.workspaceId, 'REVIEWED_EXECUTION_WORKSPACE_REQUIRED', 'workspaceId');
  if (!workspaceId.ok) return workspaceId;
  const reviewer = boundedIdentity(options.reviewer, 'REVIEWED_EXECUTION_REVIEWER_REQUIRED', 'reviewer');
  if (!reviewer.ok) return reviewer;
  const leaseOwner = boundedIdentity(options.leaseOwner, 'REVIEWED_EXECUTION_LEASE_OWNER_REQUIRED', 'leaseOwner');
  if (!leaseOwner.ok) return leaseOwner;
  const now = nowMillis(options.now);
  if (!now.ok) return now;

  const context = record.context;
  if (!exactFields(context, CONTEXT_FIELDS) || context.source !== EXTERNAL_INGEST_CONTEXT_SOURCE) {
    return failure('REVIEWED_EXECUTION_CONTEXT_INVALID', 'approval context is not the bounded reviewed external context');
  }
  const policy = record.policy;
  if (
    !exactFields(policy, POLICY_FIELDS)
    || policy.action !== 'ingest_reviewed_external_snapshot'
    || policy.approval !== 'review'
    || policy.snapshotIntegrity !== 'sha256'
    || policy.sourceAccess !== 'queue_time_only'
  ) return failure('REVIEWED_EXECUTION_POLICY_INVALID', 'approval policy does not authorize reviewed-byte-only execution');

  const claim = context.executionClaim;
  if (
    !exactFields(claim, CLAIM_FIELDS)
    || claim.owner !== leaseOwner.value
    || !Number.isFinite(Number(claim.claimedAt))
    || !Number.isFinite(Number(claim.leaseExpiresAt))
    || Number(claim.claimedAt) <= 0
    || Number(claim.leaseExpiresAt) <= Number(claim.claimedAt)
  ) return failure('REVIEWED_EXECUTION_CLAIM_INVALID', 'execution claim is malformed or owned by another worker');
  if (now.value < Number(claim.claimedAt)) {
    return failure('REVIEWED_EXECUTION_CLAIM_NOT_STARTED', 'execution claim has not started');
  }
  if (now.value >= Number(claim.leaseExpiresAt)) {
    return failure('REVIEWED_EXECUTION_LEASE_EXPIRED', 'execution lease has expired');
  }

  const approval = context.externalApproval;
  const marker = context[IDEMPOTENCY_CONTEXT_KEY];
  if (
    !marker
    || typeof marker !== 'object'
    || Array.isArray(marker)
    || Object.keys(marker).length !== 2
    || marker.version !== IDEMPOTENCY_CONTEXT_VERSION
    || marker.fingerprint !== approval?.snapshotHash
  ) return failure('REVIEWED_EXECUTION_FINGERPRINT_INVALID', 'persisted approval fingerprint is missing or inconsistent');

  if (record.approval_key !== approval?.approvalKey || record.input !== expectedInputSummary(approval)) {
    return failure('REVIEWED_EXECUTION_RECORD_INTEGRITY_MISMATCH', 'persisted approval key or input summary does not match the reviewed envelope');
  }

  const verified = verifyExternalIngestApproval(approval, {
    now: now.iso,
    expectedWorkspaceId: workspaceId.value,
    expectedRequester: requester.value,
    expectedApprovalKey: record.approval_key,
    expectedSnapshotHash: marker.fingerprint,
  });
  if (!verified.ok) return verified;

  const reviewedSource = verified.approval.payload.reviewedSource;
  const core = {
    version: REVIEWED_EXTERNAL_EXECUTION_VERSION,
    approvalId: approvalId.value,
    approvalKey: record.approval_key,
    snapshotHash: verified.approval.snapshotHash,
    reviewedManifestHash: verified.approval.reviewedManifestHash,
    sourceType: verified.approval.sourceType,
    sourceRef: verified.approval.sourceRef,
    immutableSourceId: verified.approval.immutableSourceId,
    workspaceId: verified.approval.workspaceId,
    requester: verified.approval.requester,
    reviewer: reviewer.value,
    selfApproval: reviewer.value === verified.approval.requester,
    leaseOwner: leaseOwner.value,
    leaseExpiresAt: Number(claim.leaseExpiresAt),
    preparedAt: now.iso,
    files: reviewedSource.files.map(file => ({ ...file })),
  };
  const plan = deepCopyAndFreeze({
    ...core,
    executionPlanHash: sha256(core),
  });
  return { ok: true, plan };
}

module.exports = {
  REVIEWED_EXTERNAL_EXECUTION_VERSION,
  prepareReviewedExternalExecution,
};
