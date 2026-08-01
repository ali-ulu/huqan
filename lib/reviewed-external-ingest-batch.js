'use strict';

const {
  MAX_EXTERNAL_SNAPSHOT_FILES,
  MAX_EXTERNAL_SNAPSHOT_BYTES,
  normalizeSnapshotPath,
  sha256,
  sha256Text,
} = require('./ingest');
const { REVIEWED_EXTERNAL_EXECUTION_VERSION } = require('./reviewed-external-execution');

const REVIEWED_EXTERNAL_INGEST_BATCH_VERSION = 'huqan.reviewed-external-ingest-batch.v1';
const REVIEWED_EXTERNAL_DOCUMENT_VERSION = 'huqan.reviewed-external-document.v1';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PLAN_FIELDS = new Set([
  'version',
  'approvalId',
  'approvalKey',
  'snapshotHash',
  'reviewedManifestHash',
  'sourceType',
  'sourceRef',
  'immutableSourceId',
  'workspaceId',
  'requester',
  'reviewer',
  'selfApproval',
  'leaseOwner',
  'leaseExpiresAt',
  'preparedAt',
  'files',
  'executionPlanHash',
]);
const BASE_FILE_FIELDS = new Set(['path', 'content', 'contentHash', 'sizeBytes']);
const GITHUB_FILE_FIELDS = new Set([...BASE_FILE_FIELDS, 'blobSha']);

function failure(code, error) {
  return { ok: false, code, error };
}

function exactFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every(key => allowed.has(key));
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

function executionPlanCore(plan, files = plan.files) {
  return {
    version: plan.version,
    approvalId: plan.approvalId,
    approvalKey: plan.approvalKey,
    snapshotHash: plan.snapshotHash,
    reviewedManifestHash: plan.reviewedManifestHash,
    sourceType: plan.sourceType,
    sourceRef: plan.sourceRef,
    immutableSourceId: plan.immutableSourceId,
    workspaceId: plan.workspaceId,
    requester: plan.requester,
    reviewer: plan.reviewer,
    selfApproval: plan.selfApproval,
    leaseOwner: plan.leaseOwner,
    leaseExpiresAt: plan.leaseExpiresAt,
    preparedAt: plan.preparedAt,
    files: files.map(file => ({ ...file })),
  };
}

function verifyTrustedContext(plan, options) {
  const fields = [
    ['approvalId', 'approvalId', 'REVIEWED_BATCH_APPROVAL_ID_REQUIRED'],
    ['requester', 'requester', 'REVIEWED_BATCH_REQUESTER_REQUIRED'],
    ['workspaceId', 'workspaceId', 'REVIEWED_BATCH_WORKSPACE_REQUIRED'],
    ['reviewer', 'reviewer', 'REVIEWED_BATCH_REVIEWER_REQUIRED'],
    ['leaseOwner', 'leaseOwner', 'REVIEWED_BATCH_LEASE_OWNER_REQUIRED'],
  ];

  for (const [optionKey, planKey, code] of fields) {
    const trusted = boundedPrintable(options[optionKey], optionKey, code, 128);
    if (!trusted.ok) return trusted;
    if (trusted.value !== plan[planKey]) {
      return failure('REVIEWED_BATCH_TRUST_CONTEXT_MISMATCH', `${optionKey} does not match the trusted execution context`);
    }
  }
  return { ok: true };
}

function verifyPlanIdentity(plan) {
  const boundedFields = [
    ['approvalId', 128],
    ['approvalKey', 256],
    ['sourceRef', 2048],
    ['workspaceId', 128],
    ['requester', 128],
    ['reviewer', 128],
    ['leaseOwner', 128],
  ];
  for (const [key, maxLength] of boundedFields) {
    const checked = boundedPrintable(plan[key], key, 'REVIEWED_BATCH_PLAN_IDENTITY_INVALID', maxLength);
    if (!checked.ok || checked.value !== plan[key]) {
      return failure('REVIEWED_BATCH_PLAN_IDENTITY_INVALID', `${key} is invalid`);
    }
  }

  if (!SHA256_PATTERN.test(plan.snapshotHash)
    || !SHA256_PATTERN.test(plan.reviewedManifestHash)
    || !SHA256_PATTERN.test(plan.executionPlanHash)) {
    return failure('REVIEWED_BATCH_HASH_INVALID', 'execution plan hashes must be canonical sha256 values');
  }
  if (!['github', 'markdown'].includes(plan.sourceType)) {
    return failure('REVIEWED_BATCH_SOURCE_TYPE_UNSUPPORTED', 'reviewed batch supports github or markdown only');
  }
  if (plan.sourceType === 'github') {
    if (!GIT_SHA_PATTERN.test(plan.immutableSourceId) || !plan.sourceRef.endsWith(`@${plan.immutableSourceId}`)) {
      return failure('REVIEWED_BATCH_IMMUTABLE_SOURCE_INVALID', 'GitHub execution plan is not bound to a full commit SHA');
    }
  } else if (!SHA256_PATTERN.test(plan.immutableSourceId) || !plan.sourceRef.endsWith(`@${plan.immutableSourceId}`)) {
    return failure('REVIEWED_BATCH_IMMUTABLE_SOURCE_INVALID', 'Markdown execution plan is not bound to its content-set hash');
  }
  if (typeof plan.selfApproval !== 'boolean' || plan.selfApproval !== (plan.requester === plan.reviewer)) {
    return failure('REVIEWED_BATCH_SELF_APPROVAL_INVALID', 'self-approval visibility does not match requester and reviewer identities');
  }
  return { ok: true };
}

function verifyPlanTiming(plan, options) {
  const preparedAt = canonicalTime(plan.preparedAt, 'preparedAt', 'REVIEWED_BATCH_PREPARED_AT_INVALID');
  if (!preparedAt.ok) return preparedAt;
  const now = canonicalTime(
    options.now instanceof Date ? options.now : (options.now || new Date().toISOString()),
    'now',
    'REVIEWED_BATCH_NOW_INVALID',
  );
  if (!now.ok) return now;
  if (!Number.isSafeInteger(plan.leaseExpiresAt) || plan.leaseExpiresAt <= preparedAt.millis) {
    return failure('REVIEWED_BATCH_LEASE_INVALID', 'execution lease expiry is invalid');
  }
  if (now.millis < preparedAt.millis) {
    return failure('REVIEWED_BATCH_NOT_YET_VALID', 'execution plan preparation time is in the future');
  }
  if (now.millis >= plan.leaseExpiresAt) {
    return failure('REVIEWED_BATCH_LEASE_EXPIRED', 'execution lease expired before batch materialization');
  }
  return { ok: true };
}

function verifyAndCopyFiles(plan) {
  if (!Array.isArray(plan.files) || plan.files.length === 0) {
    return failure('REVIEWED_BATCH_FILES_REQUIRED', 'reviewed execution files are required');
  }
  if (plan.files.length > MAX_EXTERNAL_SNAPSHOT_FILES) {
    return failure('REVIEWED_BATCH_FILE_LIMIT', `reviewed batch may contain at most ${MAX_EXTERNAL_SNAPSHOT_FILES} files`);
  }

  const files = [];
  const seen = new Set();
  let previousPath = '';
  let totalBytes = 0;

  for (const input of plan.files) {
    const allowed = plan.sourceType === 'github' ? GITHUB_FILE_FIELDS : BASE_FILE_FIELDS;
    if (!exactFields(input, allowed)) {
      return failure('REVIEWED_BATCH_FILE_FIELDS_INVALID', 'reviewed execution file contains unsupported or missing fields');
    }
    const filePath = normalizeSnapshotPath(input.path);
    if (!filePath || filePath !== input.path || !/\.(?:md|markdown)$/iu.test(filePath)) {
      return failure('REVIEWED_BATCH_MARKDOWN_PATH_REQUIRED', 'reviewed batch files must be canonical Markdown paths');
    }
    if (previousPath && filePath <= previousPath) {
      return failure('REVIEWED_BATCH_FILE_ORDER_INVALID', 'reviewed batch files must be strictly sorted by canonical path');
    }
    previousPath = filePath;

    const dedupeKey = filePath.normalize('NFC').toLowerCase();
    if (seen.has(dedupeKey)) {
      return failure('REVIEWED_BATCH_FILE_DUPLICATE', `duplicate reviewed file path: ${filePath}`);
    }
    seen.add(dedupeKey);

    if (typeof input.content !== 'string') {
      return failure('REVIEWED_BATCH_CONTENT_REQUIRED', `reviewed content is required for ${filePath}`);
    }
    if (input.content.length > MAX_EXTERNAL_SNAPSHOT_BYTES) {
      return failure('REVIEWED_BATCH_SIZE_LIMIT', `reviewed batch may contain at most ${MAX_EXTERNAL_SNAPSHOT_BYTES} bytes`);
    }
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');
    totalBytes += sizeBytes;
    if (totalBytes > MAX_EXTERNAL_SNAPSHOT_BYTES) {
      return failure('REVIEWED_BATCH_SIZE_LIMIT', `reviewed batch may contain at most ${MAX_EXTERNAL_SNAPSHOT_BYTES} bytes`);
    }
    if (plan.sourceType === 'github' && !GIT_SHA_PATTERN.test(input.blobSha)) {
      return failure('REVIEWED_BATCH_BLOB_SHA_REQUIRED', `GitHub reviewed file requires a canonical blob SHA: ${filePath}`);
    }

    files.push({
      path: filePath,
      content: input.content,
      contentHash: input.contentHash,
      sizeBytes,
      ...(plan.sourceType === 'github' ? { blobSha: input.blobSha } : {}),
    });
  }
  return { ok: true, files, totalBytes };
}

function verifyContentBindings(files) {
  for (const file of files) {
    if (file.contentHash !== sha256Text(file.content)) {
      return failure('REVIEWED_BATCH_CONTENT_MISMATCH', `reviewed content binding mismatch: ${file.path}`);
    }
  }
  return { ok: true };
}

function materializeReviewedExternalIngestBatch(plan, options = {}) {
  if (!exactFields(plan, PLAN_FIELDS)) {
    return failure('REVIEWED_BATCH_PLAN_FIELDS_INVALID', 'execution plan contains unsupported or missing fields');
  }
  if (plan.version !== REVIEWED_EXTERNAL_EXECUTION_VERSION) {
    return failure('REVIEWED_BATCH_PLAN_VERSION_UNSUPPORTED', 'execution plan version is unsupported');
  }

  const identity = verifyPlanIdentity(plan);
  if (!identity.ok) return identity;
  const trusted = verifyTrustedContext(plan, options);
  if (!trusted.ok) return trusted;
  const timing = verifyPlanTiming(plan, options);
  if (!timing.ok) return timing;
  const verifiedFiles = verifyAndCopyFiles(plan);
  if (!verifiedFiles.ok) return verifiedFiles;

  const expectedPlanHash = sha256(executionPlanCore(plan, verifiedFiles.files));
  if (plan.executionPlanHash !== expectedPlanHash) {
    return failure('REVIEWED_BATCH_PLAN_HASH_MISMATCH', 'execution plan no longer matches its reviewed-byte binding');
  }
  const contentBindings = verifyContentBindings(verifiedFiles.files);
  if (!contentBindings.ok) return contentBindings;

  const documents = verifiedFiles.files.map((file, index) => ({
    version: REVIEWED_EXTERNAL_DOCUMENT_VERSION,
    index,
    documentId: sha256({
      executionPlanHash: plan.executionPlanHash,
      path: file.path,
      contentHash: file.contentHash,
      ...(file.blobSha ? { blobSha: file.blobSha } : {}),
    }),
    path: file.path,
    content: file.content,
    contentHash: file.contentHash,
    sizeBytes: file.sizeBytes,
    sourceRef: `${plan.sourceRef}::${file.path}`,
    ...(file.blobSha ? { blobSha: file.blobSha } : {}),
  }));

  const core = {
    version: REVIEWED_EXTERNAL_INGEST_BATCH_VERSION,
    executionPlanHash: plan.executionPlanHash,
    approvalId: plan.approvalId,
    approvalKey: plan.approvalKey,
    snapshotHash: plan.snapshotHash,
    reviewedManifestHash: plan.reviewedManifestHash,
    sourceType: plan.sourceType,
    sourceRef: plan.sourceRef,
    immutableSourceId: plan.immutableSourceId,
    workspaceId: plan.workspaceId,
    requester: plan.requester,
    reviewer: plan.reviewer,
    selfApproval: plan.selfApproval,
    leaseOwner: plan.leaseOwner,
    leaseExpiresAt: plan.leaseExpiresAt,
    preparedAt: plan.preparedAt,
    fileCount: documents.length,
    totalBytes: verifiedFiles.totalBytes,
    documents,
  };
  const batch = deepFreeze({
    ...core,
    batchHash: sha256(core),
  });
  return { ok: true, batch };
}

module.exports = {
  REVIEWED_EXTERNAL_INGEST_BATCH_VERSION,
  REVIEWED_EXTERNAL_DOCUMENT_VERSION,
  materializeReviewedExternalIngestBatch,
};
