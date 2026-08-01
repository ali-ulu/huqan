'use strict';

const { sha256 } = require('./ingest');
const { REVIEWED_EXTERNAL_ADMISSION_VERSION } = require('./reviewed-external-admission');

const REVIEWED_EXTERNAL_ADMISSION_RESERVATION_VERSION = 'huqan.reviewed-external-admission-reservation.v1';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ADMISSION_FIELDS = new Set([
  'version',
  'approvalId',
  'approvalKey',
  'snapshotHash',
  'reviewedManifestHash',
  'executionPlanHash',
  'batchHash',
  'candidatePlanHash',
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
  'admittedAt',
  'approvalUpdatedAt',
  'approvalRecordHash',
  'documentCount',
  'sectionCount',
  'candidateCount',
  'admissionHash',
]);
const TRUSTED_FIELDS = [
  ['approvalId', 128],
  ['approvalKey', 256],
  ['snapshotHash', 128],
  ['reviewedManifestHash', 128],
  ['executionPlanHash', 128],
  ['batchHash', 128],
  ['candidatePlanHash', 128],
  ['admissionHash', 128],
  ['approvalRecordHash', 128],
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
  'admissionHash',
  'approvalRecordHash',
]);
const RESERVATION_REASON = 'reviewed_external_admission_reserved';

function failure(code, error, meta = {}) {
  return { ok: false, code, error, meta };
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

function admissionCore(admission) {
  const core = { ...admission };
  delete core.admissionHash;
  return core;
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

function verifyAdmissionIdentity(admission) {
  if (!exactFields(admission, ADMISSION_FIELDS)) {
    return failure(
      'REVIEWED_RESERVATION_ADMISSION_FIELDS_INVALID',
      'reviewed admission contains unsupported or missing fields',
    );
  }
  if (admission.version !== REVIEWED_EXTERNAL_ADMISSION_VERSION) {
    return failure(
      'REVIEWED_RESERVATION_ADMISSION_VERSION_UNSUPPORTED',
      'reviewed admission version is unsupported',
    );
  }

  for (const [key, maxLength] of TRUSTED_FIELDS) {
    const checked = boundedPrintable(
      admission[key],
      key,
      'REVIEWED_RESERVATION_ADMISSION_IDENTITY_INVALID',
      maxLength,
    );
    if (!checked.ok || checked.value !== admission[key]) {
      return failure('REVIEWED_RESERVATION_ADMISSION_IDENTITY_INVALID', `${key} is invalid`);
    }
    if (HASH_FIELDS.has(key) && !SHA256_PATTERN.test(checked.value)) {
      return failure('REVIEWED_RESERVATION_ADMISSION_HASH_INVALID', `${key} must be a canonical sha256 value`);
    }
  }

  if (!['github', 'markdown'].includes(admission.sourceType)) {
    return failure('REVIEWED_RESERVATION_SOURCE_TYPE_UNSUPPORTED', 'reviewed admission source type is unsupported');
  }
  if (admission.sourceType === 'github') {
    if (!GIT_SHA_PATTERN.test(admission.immutableSourceId)
      || !admission.sourceRef.endsWith(`@${admission.immutableSourceId}`)) {
      return failure('REVIEWED_RESERVATION_IMMUTABLE_SOURCE_INVALID', 'GitHub admission is not commit-bound');
    }
  } else if (!SHA256_PATTERN.test(admission.immutableSourceId)
    || !admission.sourceRef.endsWith(`@${admission.immutableSourceId}`)) {
    return failure('REVIEWED_RESERVATION_IMMUTABLE_SOURCE_INVALID', 'Markdown admission is not content-set-bound');
  }

  if (typeof admission.selfApproval !== 'boolean'
    || admission.selfApproval !== (admission.requester === admission.reviewer)) {
    return failure('REVIEWED_RESERVATION_SELF_APPROVAL_INVALID', 'self-approval visibility is inconsistent');
  }
  for (const key of ['documentCount', 'sectionCount', 'candidateCount']) {
    if (!Number.isSafeInteger(admission[key]) || admission[key] < 0) {
      return failure('REVIEWED_RESERVATION_COUNT_INVALID', `${key} is invalid`);
    }
  }
  if (!Number.isSafeInteger(admission.leaseExpiresAt)
    || !Number.isSafeInteger(admission.approvalUpdatedAt)
    || admission.leaseExpiresAt <= 0
    || admission.approvalUpdatedAt < 0) {
    return failure('REVIEWED_RESERVATION_METADATA_INVALID', 'lease or approval update metadata is invalid');
  }
  if (sha256(admissionCore(admission)) !== admission.admissionHash) {
    return failure('REVIEWED_RESERVATION_ADMISSION_HASH_MISMATCH', 'reviewed admission hash does not match its fields');
  }
  return { ok: true };
}

function verifyTrustedContext(admission, options) {
  for (const [key, maxLength] of TRUSTED_FIELDS) {
    const checked = boundedPrintable(
      options[key],
      key,
      'REVIEWED_RESERVATION_TRUST_CONTEXT_REQUIRED',
      maxLength,
    );
    if (!checked.ok) return checked;
    if (HASH_FIELDS.has(key) && !SHA256_PATTERN.test(checked.value)) {
      return failure('REVIEWED_RESERVATION_TRUST_HASH_INVALID', `${key} must be a canonical sha256 value`);
    }
    if (checked.value !== admission[key]) {
      return failure(
        'REVIEWED_RESERVATION_TRUST_CONTEXT_MISMATCH',
        `${key} does not match the trusted reservation context`,
      );
    }
  }
  return { ok: true };
}

function verifyRecord(admission, record, nowMillis) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return failure('REVIEWED_RESERVATION_RECORD_NOT_FOUND', 'the persisted approval record was not found');
  }
  if (record.id !== admission.approvalId
    || record.approval_key !== admission.approvalKey
    || record.tool !== 'http.ingest') {
    return failure('REVIEWED_RESERVATION_RECORD_IDENTITY_MISMATCH', 'the persisted approval identity does not match');
  }
  if (record.status !== 'executing' || record.decision !== 'approved' || Number(record.decided_at) !== 0) {
    return failure('REVIEWED_RESERVATION_RECORD_STATE_INVALID', 'the persisted approval is not executing');
  }
  if (record.context?.reviewedExternalAdmissionReservation) {
    return failure('REVIEWED_RESERVATION_ALREADY_RESERVED', 'the approval already has an admission reservation');
  }
  if (!Number.isSafeInteger(Number(record.updated_at))
    || Number(record.updated_at) !== admission.approvalUpdatedAt) {
    return failure('REVIEWED_RESERVATION_RECORD_CHANGED', 'the persisted approval changed after admission');
  }
  if (sha256(recordCore(record)) !== admission.approvalRecordHash) {
    return failure('REVIEWED_RESERVATION_RECORD_HASH_MISMATCH', 'the persisted approval fingerprint changed after admission');
  }

  const claim = record.context?.executionClaim;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    return failure('REVIEWED_RESERVATION_CLAIM_REQUIRED', 'the persisted execution claim is missing');
  }
  if (claim.owner !== admission.leaseOwner
    || Number(claim.leaseExpiresAt) !== admission.leaseExpiresAt
    || !Number.isSafeInteger(Number(claim.claimedAt))) {
    return failure('REVIEWED_RESERVATION_CLAIM_MISMATCH', 'the persisted execution claim does not match admission');
  }
  if (nowMillis >= Number(claim.leaseExpiresAt)) {
    return failure('REVIEWED_RESERVATION_LEASE_EXPIRED', 'the execution lease expired before reservation');
  }
  if (typeof record.context_json !== 'string' || !record.context_json) {
    return failure('REVIEWED_RESERVATION_CONTEXT_INVALID', 'the persisted approval context is invalid');
  }
  return { ok: true };
}

function buildReservation(admission, now) {
  const approvalUpdatedAt = Math.max(now.millis, admission.approvalUpdatedAt + 1);
  const core = {
    version: REVIEWED_EXTERNAL_ADMISSION_RESERVATION_VERSION,
    approvalId: admission.approvalId,
    approvalKey: admission.approvalKey,
    admissionHash: admission.admissionHash,
    candidatePlanHash: admission.candidatePlanHash,
    approvalRecordHash: admission.approvalRecordHash,
    workspaceId: admission.workspaceId,
    requester: admission.requester,
    reviewer: admission.reviewer,
    selfApproval: admission.selfApproval,
    leaseOwner: admission.leaseOwner,
    leaseExpiresAt: admission.leaseExpiresAt,
    admittedAt: admission.admittedAt,
    reservedAt: now.value,
    approvalUpdatedAt,
  };
  return deepFreeze({
    ...core,
    reservationHash: sha256(core),
  });
}

function reserveReviewedExternalAdmission(admission, options = {}) {
  const identity = verifyAdmissionIdentity(admission);
  if (!identity.ok) return identity;
  const trusted = verifyTrustedContext(admission, options);
  if (!trusted.ok) return trusted;

  const store = options.approvalStore;
  if (!store
    || typeof store.getToolApprovalById !== 'function'
    || !store.db
    || typeof store.db.prepare !== 'function') {
    return failure('REVIEWED_RESERVATION_STORE_REQUIRED', 'a persistent SQLite approval store is required');
  }
  if (options.now === undefined || options.now === null || options.now === '') {
    return failure('REVIEWED_RESERVATION_NOW_REQUIRED', 'an explicit trusted reservation time is required');
  }
  const now = canonicalTime(options.now, 'now', 'REVIEWED_RESERVATION_NOW_INVALID');
  if (!now.ok) return now;
  const preparedAt = canonicalTime(
    admission.preparedAt,
    'preparedAt',
    'REVIEWED_RESERVATION_PREPARED_AT_INVALID',
  );
  if (!preparedAt.ok) return preparedAt;
  const admittedAt = canonicalTime(
    admission.admittedAt,
    'admittedAt',
    'REVIEWED_RESERVATION_ADMITTED_AT_INVALID',
  );
  if (!admittedAt.ok) return admittedAt;
  if (admittedAt.millis < preparedAt.millis) {
    return failure('REVIEWED_RESERVATION_ADMISSION_TIME_INVALID', 'admission predates candidate preparation');
  }
  if (now.millis < admittedAt.millis || now.millis < admission.approvalUpdatedAt) {
    return failure('REVIEWED_RESERVATION_NOT_YET_VALID', 'reservation time predates the admitted approval state');
  }
  if (now.millis >= admission.leaseExpiresAt) {
    return failure('REVIEWED_RESERVATION_LEASE_EXPIRED', 'the execution lease expired before reservation');
  }

  let record;
  try {
    record = store.getToolApprovalById(admission.approvalId);
  } catch (_) {
    return failure('REVIEWED_RESERVATION_STORE_READ_FAILED', 'the persistent approval record could not be read');
  }
  const verified = verifyRecord(admission, record, now.millis);
  if (!verified.ok) return verified;

  const reservation = buildReservation(admission, now);
  const nextContext = {
    ...record.context,
    reviewedExternalAdmissionReservation: reservation,
  };

  let result;
  try {
    const statement = store.db.prepare(`
      UPDATE tool_approvals
      SET context_json = @context_json,
          reason = @reason,
          updated_at = @updated_at
      WHERE id = @id
        AND approval_key = @approval_key
        AND tool = 'http.ingest'
        AND status = 'executing'
        AND decision = 'approved'
        AND decided_at = 0
        AND updated_at = @expected_updated_at
        AND context_json = @expected_context_json
        AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) < @lease_expires_at
    `);
    result = statement.run({
      id: admission.approvalId,
      approval_key: admission.approvalKey,
      context_json: JSON.stringify(nextContext),
      reason: RESERVATION_REASON,
      updated_at: reservation.approvalUpdatedAt,
      expected_updated_at: admission.approvalUpdatedAt,
      expected_context_json: record.context_json,
      lease_expires_at: admission.leaseExpiresAt,
    });
  } catch (_) {
    return failure('REVIEWED_RESERVATION_STORE_WRITE_FAILED', 'the admission reservation could not be persisted');
  }

  if (Number(result?.changes || 0) !== 1) {
    let current = null;
    try {
      current = store.getToolApprovalById(admission.approvalId);
    } catch (_) {
      return failure('REVIEWED_RESERVATION_STORE_READ_FAILED', 'the reservation result could not be verified');
    }
    if (current?.context?.reviewedExternalAdmissionReservation) {
      return failure('REVIEWED_RESERVATION_ALREADY_RESERVED', 'the approval already has an admission reservation');
    }
    return failure('REVIEWED_RESERVATION_CAS_FAILED', 'the persisted approval changed before reservation');
  }

  return { ok: true, reservation };
}

module.exports = {
  REVIEWED_EXTERNAL_ADMISSION_RESERVATION_VERSION,
  reserveReviewedExternalAdmission,
};
