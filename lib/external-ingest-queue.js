'use strict';

const crypto = require('crypto');

const {
  EXTERNAL_INGEST_APPROVAL_VERSION,
  MAX_EXTERNAL_APPROVAL_WINDOW_MS,
  resolveExternalIngestApproval,
} = require('./external-ingest-approval');
const { normalizeSourceType, sha256 } = require('./ingest');
const { saveToolApprovalWithIdempotencyConflict } = require('./tool-approval-idempotency');

const EXTERNAL_INGEST_TOOL = 'http.ingest';
const EXTERNAL_INGEST_CONTEXT_SOURCE = 'http-external-ingest';

function failure(code, error, extras = {}) {
  return { ok: false, code, error, ...extras };
}

function boundedIdentity(value, code, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/u.test(text)) {
    return failure(code, `${label} is required and must be a bounded printable string`);
  }
  return { ok: true, value: text };
}

function requestIdentity(data = {}) {
  const requester = boundedIdentity(data.requester, 'EXTERNAL_QUEUE_REQUESTER_REQUIRED', 'requester');
  if (!requester.ok) return requester;
  const workspaceId = boundedIdentity(data.workspaceId, 'EXTERNAL_QUEUE_WORKSPACE_REQUIRED', 'workspaceId');
  if (!workspaceId.ok) return workspaceId;
  const idempotencyKey = String(data.idempotencyKey || data.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)) {
    return failure('EXTERNAL_QUEUE_IDEMPOTENCY_KEY_REQUIRED', 'an explicit bounded idempotencyKey is required');
  }
  const requestIdentityHash = sha256({
    version: EXTERNAL_INGEST_APPROVAL_VERSION,
    workspaceId: workspaceId.value,
    requester: requester.value,
    idempotencyKey,
  });
  return {
    ok: true,
    requester: requester.value,
    workspaceId: workspaceId.value,
    idempotencyKey,
    requestIdentityHash,
    approvalKey: `http.ingest.external.${requestIdentityHash.slice('sha256:'.length)}`,
  };
}

function canonicalNow(value) {
  const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
  if (!Number.isFinite(date.getTime())) return failure('EXTERNAL_QUEUE_NOW_INVALID', 'queue time is invalid');
  return { ok: true, date, iso: date.toISOString() };
}

function existingEnvelope(record) {
  const envelope = record?.context?.externalApproval;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  if (typeof envelope.requestedAt !== 'string' || typeof envelope.expiresAt !== 'string') return null;
  return envelope;
}

function publicQueueApproval(record, envelope) {
  return {
    id: String(record?.id || ''),
    status: String(record?.status || ''),
    decision: String(record?.decision || ''),
    reason: String(record?.reason || ''),
    createdAt: Number(record?.created_at || record?.createdAt || 0),
    updatedAt: Number(record?.updated_at || record?.updatedAt || 0),
    sourceType: envelope.sourceType,
    sourceRef: envelope.sourceRef,
    immutableSourceId: envelope.immutableSourceId,
    reviewedManifestHash: envelope.reviewedManifestHash,
    snapshotHash: envelope.snapshotHash,
    requester: envelope.requester,
    workspaceId: envelope.workspaceId,
    idempotencyKey: envelope.idempotencyKey,
    requestedAt: envelope.requestedAt,
    expiresAt: envelope.expiresAt,
  };
}

async function queueReviewedExternalIngest(store, data = {}, options = {}) {
  if (
    !store
    || typeof store.getToolApprovalByKey !== 'function'
    || typeof store.saveToolApprovalIfAbsent !== 'function'
  ) return failure('EXTERNAL_QUEUE_STORE_REQUIRED', 'a persistent approval store is required');

  const sourceType = normalizeSourceType(data.sourceType || data.source);
  if (!['github', 'markdown'].includes(sourceType)) {
    return failure('EXTERNAL_QUEUE_SOURCE_TYPE_UNSUPPORTED', 'reviewed external queue supports github or markdown only');
  }
  const identity = requestIdentity(data);
  if (!identity.ok) return identity;
  const now = canonicalNow(options.now);
  if (!now.ok) return now;

  const existing = store.getToolApprovalByKey(identity.approvalKey);
  const existingApproval = existingEnvelope(existing);
  if (existing && !existingApproval) {
    return failure(
      'APPROVAL_IDEMPOTENCY_CONFLICT',
      'approvalKey is occupied by an unverifiable legacy or malformed request',
      { conflict: true, existingApprovalId: String(existing.id || ''), existingStatus: String(existing.status || '') },
    );
  }

  const requestedAt = existingApproval?.requestedAt || now.iso;
  const expiresAt = existingApproval?.expiresAt
    || new Date(now.date.getTime() + MAX_EXTERNAL_APPROVAL_WINDOW_MS).toISOString();
  const resolved = await resolveExternalIngestApproval({
    ...data,
    sourceType,
    requester: identity.requester,
    workspaceId: identity.workspaceId,
    idempotencyKey: identity.idempotencyKey,
    requestedAt,
    expiresAt,
  }, options.resolverOptions || options);
  if (!resolved.ok) return resolved;

  const approval = resolved.approval;
  if (
    approval.requestIdentityHash !== identity.requestIdentityHash
    || approval.approvalKey !== identity.approvalKey
  ) return failure('EXTERNAL_QUEUE_IDENTITY_MISMATCH', 'resolved approval identity does not match the queue request');

  const record = {
    id: `ingest-approval-${crypto.randomUUID()}`,
    approvalKey: approval.approvalKey,
    tool: EXTERNAL_INGEST_TOOL,
    input: JSON.stringify(approval.payload),
    context: {
      source: EXTERNAL_INGEST_CONTEXT_SOURCE,
      externalApproval: approval,
    },
    policy: {
      action: 'ingest_reviewed_external_snapshot',
      approval: 'review',
      snapshotIntegrity: 'sha256',
      sourceAccess: 'queue_time_only',
    },
    status: 'pending',
    decision: 'review',
    reason: 'external_ingest_requires_review',
  };
  const saved = saveToolApprovalWithIdempotencyConflict(store, record, approval.snapshotHash);
  if (!saved.ok) return saved;

  const persistedEnvelope = existingEnvelope(saved.approval);
  if (!persistedEnvelope) return failure('EXTERNAL_QUEUE_STORE_RESULT_INVALID', 'persisted approval envelope is unavailable');
  return {
    ok: true,
    inserted: saved.inserted,
    idempotent: saved.idempotent,
    conflict: false,
    approval: publicQueueApproval(saved.approval, persistedEnvelope),
  };
}

module.exports = {
  EXTERNAL_INGEST_CONTEXT_SOURCE,
  EXTERNAL_INGEST_TOOL,
  queueReviewedExternalIngest,
};
