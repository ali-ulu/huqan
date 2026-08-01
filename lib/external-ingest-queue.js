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

function validateExistingEnvelope(record, envelope, identity, now) {
  if (
    record.approval_key !== identity.approvalKey
    || envelope.approvalKey !== identity.approvalKey
    || envelope.requestIdentityHash !== identity.requestIdentityHash
    || envelope.requester !== identity.requester
    || envelope.workspaceId !== identity.workspaceId
    || envelope.idempotencyKey !== identity.idempotencyKey
  ) {
    return failure('APPROVAL_IDEMPOTENCY_CONFLICT', 'persisted approval identity is inconsistent', {
      conflict: true,
      existingApprovalId: String(record.id || ''),
      existingStatus: String(record.status || ''),
    });
  }

  const requestedMs = Date.parse(envelope.requestedAt);
  const expiresMs = Date.parse(envelope.expiresAt);
  if (
    !Number.isFinite(requestedMs)
    || !Number.isFinite(expiresMs)
    || new Date(requestedMs).toISOString() !== envelope.requestedAt
    || new Date(expiresMs).toISOString() !== envelope.expiresAt
    || expiresMs <= requestedMs
    || expiresMs - requestedMs > MAX_EXTERNAL_APPROVAL_WINDOW_MS
  ) {
    return failure('APPROVAL_IDEMPOTENCY_CONFLICT', 'persisted approval validity window is unverifiable', {
      conflict: true,
      existingApprovalId: String(record.id || ''),
      existingStatus: String(record.status || ''),
    });
  }
  if (now.date.getTime() < requestedMs) {
    return failure('EXTERNAL_APPROVAL_NOT_YET_VALID', 'persisted approval validity window has not started');
  }
  if (now.date.getTime() >= expiresMs) {
    return failure('EXTERNAL_APPROVAL_EXPIRED', 'persisted approval validity window has expired');
  }
  return { ok: true };
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

function queueInputSummary(approval) {
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

function queueRecord(approval) {
  return {
    id: `ingest-approval-${crypto.randomUUID()}`,
    approvalKey: approval.approvalKey,
    tool: EXTERNAL_INGEST_TOOL,
    input: queueInputSummary(approval),
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
}

async function resolveForWindow(data, sourceType, identity, requestedAt, expiresAt, options) {
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
  if (
    resolved.approval.requestIdentityHash !== identity.requestIdentityHash
    || resolved.approval.approvalKey !== identity.approvalKey
  ) return failure('EXTERNAL_QUEUE_IDENTITY_MISMATCH', 'resolved approval identity does not match the queue request');
  return resolved;
}

function saveResolved(store, approval) {
  return saveToolApprovalWithIdempotencyConflict(store, queueRecord(approval), approval.snapshotHash);
}

function successResult(saved) {
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
  if (existingApproval) {
    const existingValidity = validateExistingEnvelope(existing, existingApproval, identity, now);
    if (!existingValidity.ok) return existingValidity;
  }

  const requestedAt = existingApproval?.requestedAt || now.iso;
  const expiresAt = existingApproval?.expiresAt
    || new Date(now.date.getTime() + MAX_EXTERNAL_APPROVAL_WINDOW_MS).toISOString();
  const resolved = await resolveForWindow(data, sourceType, identity, requestedAt, expiresAt, options);
  if (!resolved.ok) return resolved;

  let saved = saveResolved(store, resolved.approval);
  if (!saved.ok && saved.code === 'APPROVAL_IDEMPOTENCY_CONFLICT' && !existing) {
    const raced = store.getToolApprovalByKey(identity.approvalKey);
    const racedEnvelope = existingEnvelope(raced);
    if (!raced || !racedEnvelope) return saved;
    const raceValidity = validateExistingEnvelope(raced, racedEnvelope, identity, now);
    if (!raceValidity.ok) return raceValidity;
    const racedResolution = await resolveForWindow(
      data,
      sourceType,
      identity,
      racedEnvelope.requestedAt,
      racedEnvelope.expiresAt,
      options,
    );
    if (!racedResolution.ok) return racedResolution;
    saved = saveResolved(store, racedResolution.approval);
  }
  if (!saved.ok) return saved;
  return successResult(saved);
}

module.exports = {
  EXTERNAL_INGEST_CONTEXT_SOURCE,
  EXTERNAL_INGEST_TOOL,
  queueReviewedExternalIngest,
};
