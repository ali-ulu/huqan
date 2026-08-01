'use strict';

const { isDeepStrictEqual } = require('node:util');
const { sha256 } = require('./ingest');
const { prepareReviewedExternalExecution } = require('./reviewed-external-execution');
const { materializeReviewedExternalIngestBatch } = require('./reviewed-external-ingest-batch');
const {
  REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION,
  buildReviewedExternalCandidatePlan,
} = require('./reviewed-external-ingest-candidates');

const REVIEWED_EXTERNAL_ADMISSION_VERSION = 'huqan.reviewed-external-admission.v1';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TRUSTED_FIELDS = [
  ['approvalId', 128],
  ['approvalKey', 256],
  ['snapshotHash', 128],
  ['reviewedManifestHash', 128],
  ['executionPlanHash', 128],
  ['batchHash', 128],
  ['candidatePlanHash', 128],
  ['sourceType', 32],
  ['sourceRef', 2048],
  ['immutableSourceId', 128],
  ['workspaceId', 128],
  ['requester', 128],
  ['reviewer', 128],
  ['leaseOwner', 128],
];
const HASH_FIELDS = new Set([
  'snapshotHash',
  'reviewedManifestHash',
  'executionPlanHash',
  'batchHash',
  'candidatePlanHash',
]);

function failure(code, error, meta = {}) {
  return { ok: false, code, error, meta };
}

function boundedPrintable(value, label, code, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    return failure(code, `${label} is required and must be a bounded printable string`);
  }
  return { ok: true, value: text };
}

function canonicalTime(value, label, code) {
  const text = value instanceof Date ? value.toISOString() : String(value == null ? '' : value).trim();
  const millis = Date.parse(text);
  if (!text || !Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    return failure(code, `${label} must be a canonical ISO-8601 timestamp`);
  }
  return { ok: true, value: text, millis };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function verifyTrustedBindings(candidatePlan, options) {
  const trusted = {};
  for (const [key, maxLength] of TRUSTED_FIELDS) {
    const checked = boundedPrintable(
      options[key],
      key,
      'REVIEWED_ADMISSION_TRUST_CONTEXT_REQUIRED',
      maxLength,
    );
    if (!checked.ok) return checked;
    if (HASH_FIELDS.has(key) && !SHA256_PATTERN.test(checked.value)) {
      return failure('REVIEWED_ADMISSION_TRUST_HASH_INVALID', `${key} must be a canonical sha256 value`);
    }
    if (candidatePlan[key] !== checked.value) {
      return failure(
        'REVIEWED_ADMISSION_TRUST_CONTEXT_MISMATCH',
        `${key} does not match the trusted admission context`,
      );
    }
    trusted[key] = checked.value;
  }
  return { ok: true, trusted };
}

function executionOptions(trusted, now) {
  return {
    now,
    requester: trusted.requester,
    workspaceId: trusted.workspaceId,
    reviewer: trusted.reviewer,
    leaseOwner: trusted.leaseOwner,
  };
}

function batchOptions(plan, now) {
  return {
    now,
    approvalId: plan.approvalId,
    requester: plan.requester,
    workspaceId: plan.workspaceId,
    reviewer: plan.reviewer,
    leaseOwner: plan.leaseOwner,
  };
}

function candidateOptions(batch, now) {
  return {
    now,
    approvalId: batch.approvalId,
    approvalKey: batch.approvalKey,
    snapshotHash: batch.snapshotHash,
    reviewedManifestHash: batch.reviewedManifestHash,
    executionPlanHash: batch.executionPlanHash,
    batchHash: batch.batchHash,
    sourceType: batch.sourceType,
    sourceRef: batch.sourceRef,
    immutableSourceId: batch.immutableSourceId,
    workspaceId: batch.workspaceId,
    requester: batch.requester,
    reviewer: batch.reviewer,
    leaseOwner: batch.leaseOwner,
  };
}

function recordCore(record) {
  return {
    id: record.id,
    approvalKey: record.approval_key,
    tool: record.tool,
    input: record.input,
    context: record.context,
    policy: record.policy,
    status: record.status,
    decision: record.decision,
    reason: record.reason,
    createdAt: Number(record.created_at),
    updatedAt: Number(record.updated_at),
    decidedAt: Number(record.decided_at),
  };
}

function validateRecordMetadata(record, approvalId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return failure('REVIEWED_ADMISSION_RECORD_NOT_FOUND', 'the persisted approval record was not found');
  }
  if (record.id !== approvalId) {
    return failure('REVIEWED_ADMISSION_RECORD_ID_MISMATCH', 'the persisted approval record identity does not match');
  }
  for (const key of ['created_at', 'updated_at', 'decided_at']) {
    const value = Number(record[key]);
    if (!Number.isSafeInteger(value) || value < 0) {
      return failure('REVIEWED_ADMISSION_RECORD_METADATA_INVALID', `persisted approval ${key} is invalid`);
    }
  }
  return { ok: true };
}

function wrappedFailure(code, message, result) {
  return failure(code, message, {
    causeCode: result?.code || 'UNKNOWN',
  });
}

function admitReviewedExternalCandidatePlan(candidatePlan, options = {}) {
  if (!candidatePlan || typeof candidatePlan !== 'object' || Array.isArray(candidatePlan)) {
    return failure('REVIEWED_ADMISSION_CANDIDATE_PLAN_REQUIRED', 'a reviewed candidate plan is required');
  }
  if (candidatePlan.version !== REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION) {
    return failure('REVIEWED_ADMISSION_CANDIDATE_VERSION_UNSUPPORTED', 'reviewed candidate plan version is unsupported');
  }

  const store = options.approvalStore;
  if (!store || typeof store.getToolApprovalById !== 'function') {
    return failure('REVIEWED_ADMISSION_STORE_REQUIRED', 'a persistent approval reader is required');
  }

  const trustedResult = verifyTrustedBindings(candidatePlan, options);
  if (!trustedResult.ok) return trustedResult;
  const trusted = trustedResult.trusted;

  if (options.now === undefined || options.now === null || options.now === '') {
    return failure('REVIEWED_ADMISSION_NOW_REQUIRED', 'an explicit trusted admission time is required');
  }
  const now = canonicalTime(options.now, 'now', 'REVIEWED_ADMISSION_NOW_INVALID');
  if (!now.ok) return now;
  const preparedAt = canonicalTime(
    candidatePlan.preparedAt,
    'preparedAt',
    'REVIEWED_ADMISSION_PREPARED_AT_INVALID',
  );
  if (!preparedAt.ok) return preparedAt;
  if (now.millis < preparedAt.millis) {
    return failure('REVIEWED_ADMISSION_NOT_YET_VALID', 'candidate plan preparation time is in the future');
  }

  let record;
  try {
    record = store.getToolApprovalById(trusted.approvalId);
  } catch (_) {
    return failure('REVIEWED_ADMISSION_STORE_READ_FAILED', 'the persistent approval record could not be read');
  }
  const metadata = validateRecordMetadata(record, trusted.approvalId);
  if (!metadata.ok) return metadata;

  const current = prepareReviewedExternalExecution(record, executionOptions(trusted, now.value));
  if (!current.ok) {
    return wrappedFailure(
      'REVIEWED_ADMISSION_PERSISTED_STATE_INVALID',
      'the current persistent approval, source, or lease state is not admissible',
      current,
    );
  }

  const prepared = prepareReviewedExternalExecution(record, executionOptions(trusted, preparedAt.value));
  if (!prepared.ok) {
    return wrappedFailure(
      'REVIEWED_ADMISSION_PREPARED_STATE_INVALID',
      'the persisted approval cannot reproduce the candidate preparation state',
      prepared,
    );
  }

  const rebuiltBatch = materializeReviewedExternalIngestBatch(
    prepared.plan,
    batchOptions(prepared.plan, preparedAt.value),
  );
  if (!rebuiltBatch.ok) {
    return wrappedFailure(
      'REVIEWED_ADMISSION_BATCH_REBUILD_FAILED',
      'the reviewed in-memory batch could not be reproduced from persistent state',
      rebuiltBatch,
    );
  }

  const rebuiltCandidate = buildReviewedExternalCandidatePlan(
    rebuiltBatch.batch,
    candidateOptions(rebuiltBatch.batch, preparedAt.value),
  );
  if (!rebuiltCandidate.ok) {
    return wrappedFailure(
      'REVIEWED_ADMISSION_CANDIDATE_REBUILD_FAILED',
      'the reviewed candidate plan could not be reproduced from persistent state',
      rebuiltCandidate,
    );
  }

  if (
    rebuiltCandidate.plan.candidatePlanHash !== trusted.candidatePlanHash
    || candidatePlan.candidatePlanHash !== trusted.candidatePlanHash
    || !isDeepStrictEqual(candidatePlan, rebuiltCandidate.plan)
  ) {
    return failure(
      'REVIEWED_ADMISSION_CANDIDATE_MISMATCH',
      'candidate plan does not exactly match the plan rebuilt from persistent reviewed bytes',
    );
  }

  const approvalRecordHash = sha256(recordCore(record));
  const core = {
    version: REVIEWED_EXTERNAL_ADMISSION_VERSION,
    approvalId: rebuiltCandidate.plan.approvalId,
    approvalKey: rebuiltCandidate.plan.approvalKey,
    snapshotHash: rebuiltCandidate.plan.snapshotHash,
    reviewedManifestHash: rebuiltCandidate.plan.reviewedManifestHash,
    executionPlanHash: rebuiltCandidate.plan.executionPlanHash,
    batchHash: rebuiltCandidate.plan.batchHash,
    candidatePlanHash: rebuiltCandidate.plan.candidatePlanHash,
    sourceType: rebuiltCandidate.plan.sourceType,
    sourceRef: rebuiltCandidate.plan.sourceRef,
    immutableSourceId: rebuiltCandidate.plan.immutableSourceId,
    workspaceId: rebuiltCandidate.plan.workspaceId,
    requester: rebuiltCandidate.plan.requester,
    reviewer: rebuiltCandidate.plan.reviewer,
    selfApproval: rebuiltCandidate.plan.selfApproval,
    leaseOwner: rebuiltCandidate.plan.leaseOwner,
    leaseExpiresAt: rebuiltCandidate.plan.leaseExpiresAt,
    preparedAt: rebuiltCandidate.plan.preparedAt,
    admittedAt: now.value,
    approvalUpdatedAt: Number(record.updated_at),
    approvalRecordHash,
    documentCount: rebuiltCandidate.plan.documentCount,
    sectionCount: rebuiltCandidate.plan.sectionCount,
    candidateCount: rebuiltCandidate.plan.candidateCount,
  };
  const admission = deepFreeze({
    ...core,
    admissionHash: sha256(core),
  });
  return { ok: true, admission };
}

module.exports = {
  REVIEWED_EXTERNAL_ADMISSION_VERSION,
  admitReviewedExternalCandidatePlan,
};
