// Memory admission request: normalisation, validation, building, and the
// signals read off a proposed memory (quarantine, expiry, canonical mutation).
// Moved out of memory-admission-gate.js (#2184).

const { APPROVAL_REQUEST_STATUSES } = require('./approval-schema');
const { DEFAULT_WORKSPACE_ID, clampScore, clone, isPlainObject, makeAdmissionId, normalizeApprovalStatus, nowIso, pushError, trimText } = require('./memory-admission-gate-contract');

function isQuarantineSignal(proposedMemory = {}) {
  return Boolean(
    proposedMemory &&
    (
      proposedMemory.tombstone ||
      proposedMemory.tombstoned ||
      proposedMemory.deleted ||
      proposedMemory.deletedAt ||
      proposedMemory.superseded ||
      proposedMemory.supersede ||
      trimText(proposedMemory.status).toLowerCase() === 'deleted' ||
      trimText(proposedMemory.status).toLowerCase() === 'superseded'
    )
  );
}

/**
 * True when the request declares an expiry that is not strictly after the
 * moment of admission. Equality counts as expired: a record whose life ends the
 * instant it begins was never authoritative for any read.
 */
function isExpiredAtAdmission(request = {}) {
  const expiresAt = trimText(request.expiresAt);
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return false; // validation already rejects this
  const createdAt = Date.parse(trimText(request.createdAt) || nowIso());
  if (Number.isNaN(createdAt)) return false;
  return expiry <= createdAt;
}

function hasCanonicalMutation(proposedMemory = {}) {
  return Boolean(
    proposedMemory &&
    (
      proposedMemory.content !== undefined ||
      proposedMemory.links !== undefined ||
      proposedMemory.edges !== undefined ||
      proposedMemory.audit !== undefined ||
      proposedMemory.metadata !== undefined ||
      proposedMemory.supersedesMemoryId !== undefined ||
      isQuarantineSignal(proposedMemory)
    )
  );
}

function normalizeMemoryAdmissionRequest(request = {}, opts = {}) {
  const source = isPlainObject(request) ? request : {};
  const next = clone(source) || {};
  const approvalRequired = Boolean(opts.approvalRequired ?? source.approvalRequired ?? source.requiresApproval ?? false);

  next.admissionId = trimText(next.admissionId, trimText(opts.admissionId, ''));
  next.workspaceId = trimText(next.workspaceId, trimText(opts.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID);
  next.actor = trimText(next.actor, trimText(opts.actor, ''));
  next.agentId = trimText(next.agentId, trimText(opts.agentId, ''));
  next.memoryDraftId = trimText(next.memoryDraftId, trimText(opts.memoryDraftId, ''));
  next.proposedMemory = next.proposedMemory !== undefined ? clone(next.proposedMemory) : clone(opts.proposedMemory);
  next.provenanceId = trimText(next.provenanceId, trimText(opts.provenanceId, ''));
  next.trustPolicyVersion = trimText(next.trustPolicyVersion, trimText(opts.trustPolicyVersion, ''));
  next.approvalId = trimText(next.approvalId, trimText(opts.approvalId, ''));
  next.approvalStatus = normalizeApprovalStatus(
    next.approvalStatus ?? opts.approvalStatus,
    approvalRequired || Boolean(next.approvalId)
  );
  next.receiptId = trimText(next.receiptId, trimText(opts.receiptId, ''));
  next.reason = trimText(next.reason, trimText(opts.reason, ''));
  next.riskScore = clampScore(next.riskScore ?? opts.riskScore, 0);
  next.createdAt = trimText(next.createdAt, trimText(opts.createdAt, ''));
  // "Does it expire?" is a write-boundary question: knowledge with a known
  // shelf life should declare it at admission rather than be discovered stale
  // on read. Absent a declaration the field stays empty and every downstream
  // byte is unchanged, so existing receipts and their hash chain are untouched.
  next.expiresAt = trimText(next.expiresAt, trimText(opts.expiresAt, ''));
  next.provenanceSource = trimText(next.provenanceSource, trimText(opts.provenanceSource, ''));
  next.metadata = next.metadata !== undefined ? clone(next.metadata) : clone(opts.metadata);
  next.approvalRequired = approvalRequired;
  return next;
}

function validateMemoryAdmissionRequest(request = {}) {
  const warnings = [];
  const errors = [];
  const normalized = normalizeMemoryAdmissionRequest(request);

  if (!isPlainObject(request)) {
    pushError(errors, '', 'memory admission request must be an object', 'INVALID_MEMORY_ADMISSION_REQUEST');
    return { ok: false, type: 'memory-admission-request', warnings, errors, request: normalized };
  }

  const requiredStrings = [
    'admissionId',
    'workspaceId',
    'actor',
    'agentId',
    'memoryDraftId',
    'trustPolicyVersion',
    'reason',
    'createdAt',
  ];

  for (const field of requiredStrings) {
    if (!trimText(normalized[field])) pushError(errors, field, `${field} is required`);
  }

  // proposedMemory has already passed cloneJson in normalization. At this
  // boundary the remaining semantic question is its shape, not whether JSON
  // serialization can be attempted a second time.
  if (!isPlainObject(normalized.proposedMemory)) {
    pushError(errors, 'proposedMemory', 'proposedMemory is required');
  }

  // normalizeMemoryAdmissionRequest clamps riskScore to 0..100 before this
  // validator runs, so a second finite/range branch was unreachable.

  if (normalized.createdAt && Number.isNaN(Date.parse(normalized.createdAt))) {
    pushError(errors, 'createdAt', 'createdAt must be a parseable timestamp');
  }

  // An expiry the gate cannot read is worse than no expiry: it looks like a
  // shelf life while enforcing nothing. Fail the request instead of dropping it.
  if (normalized.expiresAt && Number.isNaN(Date.parse(normalized.expiresAt))) {
    pushError(errors, 'expiresAt', 'expiresAt must be a parseable timestamp');
  }

  if (normalized.approvalStatus && !APPROVAL_REQUEST_STATUSES.includes(normalized.approvalStatus) && normalized.approvalStatus !== 'not_required') {
    pushError(errors, 'approvalStatus', 'approvalStatus is not supported');
  }

  if (normalized.provenanceSource && !['deterministic', 'permitted_fallback'].includes(normalized.provenanceSource)) pushError(errors, 'provenanceSource', "provenanceSource must be 'deterministic' or 'permitted_fallback' when present");
  return { ok: errors.length === 0, type: 'memory-admission-request', warnings, errors, request: normalized };
}

function buildMemoryAdmissionRequest(request = {}, opts = {}) { if (!isPlainObject(request)) return validateMemoryAdmissionRequest(request);
  const now = trimText(opts.createdAt, trimText(request.createdAt, nowIso())) || nowIso();
  const normalized = normalizeMemoryAdmissionRequest(request, {
    ...opts,
    admissionId: opts.admissionId || request.admissionId || '',
    workspaceId: opts.workspaceId || request.workspaceId || DEFAULT_WORKSPACE_ID,
    createdAt: now,
    riskScore: opts.riskScore ?? request.riskScore ?? 0,
    approvalRequired: opts.approvalRequired ?? request.approvalRequired ?? request.requiresApproval ?? false,
  });

  if (!trimText(normalized.admissionId)) normalized.admissionId = makeAdmissionId(normalized);
  if (!trimText(normalized.workspaceId)) normalized.workspaceId = DEFAULT_WORKSPACE_ID;
  normalized.createdAt = now; normalized.riskScore = clampScore(opts.riskScore ?? request.riskScore ?? 0);
  if (!trimText(normalized.approvalStatus)) normalized.approvalStatus = normalized.approvalRequired ? 'pending' : 'not_required';
  if (!normalized.metadata) normalized.metadata = {};

  const validation = validateMemoryAdmissionRequest(normalized);
  return validation.ok
    ? { ...validation, request: normalized }
    : validation;
}

module.exports = {
  buildMemoryAdmissionRequest,
  hasCanonicalMutation,
  isExpiredAtAdmission,
  isQuarantineSignal,
  normalizeMemoryAdmissionRequest,
  validateMemoryAdmissionRequest,
};
