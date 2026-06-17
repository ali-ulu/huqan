const crypto = require('crypto');

const { APPROVAL_REQUEST_STATUSES } = require('./approval-schema');

const MEMORY_ADMISSION_DECISIONS = Object.freeze([
  'allow',
  'review',
  'reject',
  'quarantine',
]);

const MEMORY_ADMISSION_RECEIPT_KINDS = Object.freeze([
  'memory_admission_receipt',
  'memory_review_receipt',
  'memory_rejection_receipt',
  'memory_quarantine_receipt',
]);

const MEMORY_ADMISSION_POLICY_VERSION = 'V3-PR4-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function trimText(value, fallback = '') {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function clampScore(value, fallback = 0) {
  const score = Number(value);
  if (!Number.isFinite(score)) return fallback;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function isJsonSafe(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch (_) {
    return false;
  }
}

function pushError(errors, field, message, code = 'VALIDATION_ERROR') {
  errors.push({ code, field, message });
}

function makeAdmissionId(request) {
  const basis = [
    request.workspaceId || DEFAULT_WORKSPACE_ID,
    request.agentId || '',
    request.actor || '',
    request.memoryDraftId || '',
    request.provenanceId || '',
    request.reason || '',
    request.createdAt || '',
  ].join('|');
  return `madm_${crypto.createHash('sha1').update(basis, 'utf8').digest('hex').slice(0, 16)}`;
}

function normalizeDecision(value) {
  const raw = trimText(value, '').toLowerCase();
  return MEMORY_ADMISSION_DECISIONS.includes(raw) ? raw : '';
}

function normalizeApprovalStatus(value, approvalRequired = false) {
  const raw = trimText(value, '').toLowerCase();
  if (!raw) return approvalRequired ? 'pending' : 'not_required';
  if (APPROVAL_REQUEST_STATUSES.includes(raw)) return raw;
  if (raw === 'not_required') return raw;
  return '';
}

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

  if (!isPlainObject(normalized.proposedMemory)) {
    pushError(errors, 'proposedMemory', 'proposedMemory is required');
  } else if (!isJsonSafe(normalized.proposedMemory)) {
    pushError(errors, 'proposedMemory', 'proposedMemory must be JSON-safe');
  }

  if (!Number.isFinite(normalized.riskScore)) {
    pushError(errors, 'riskScore', 'riskScore must be a finite number');
  } else if (normalized.riskScore < 0 || normalized.riskScore > 100) {
    pushError(errors, 'riskScore', 'riskScore must be between 0 and 100');
  }

  if (normalized.metadata !== undefined && normalized.metadata !== null && !isJsonSafe(normalized.metadata)) {
    pushError(errors, 'metadata', 'metadata must be JSON-safe');
  }

  if (normalized.createdAt && Number.isNaN(Date.parse(normalized.createdAt))) {
    pushError(errors, 'createdAt', 'createdAt must be a parseable timestamp');
  }

  if (normalized.provenanceId && typeof normalized.provenanceId !== 'string') {
    pushError(errors, 'provenanceId', 'provenanceId must be a string when present');
  }

  if (normalized.approvalId && typeof normalized.approvalId !== 'string') {
    pushError(errors, 'approvalId', 'approvalId must be a string when present');
  }

  if (normalized.approvalStatus && !APPROVAL_REQUEST_STATUSES.includes(normalized.approvalStatus) && normalized.approvalStatus !== 'not_required') {
    pushError(errors, 'approvalStatus', 'approvalStatus is not supported');
  }

  return { ok: errors.length === 0, type: 'memory-admission-request', warnings, errors, request: normalized };
}

function buildMemoryAdmissionRequest(request = {}, opts = {}) {
  const now = trimText(opts.createdAt, nowIso()) || nowIso();
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
  if (!trimText(normalized.createdAt)) normalized.createdAt = nowIso();
  if (!trimText(normalized.approvalStatus)) normalized.approvalStatus = normalized.approvalRequired ? 'pending' : 'not_required';
  if (!normalized.metadata) normalized.metadata = {};

  const validation = validateMemoryAdmissionRequest(normalized);
  return validation.ok
    ? { ...validation, request: normalized }
    : validation;
}

function buildMemoryAdmissionReceipt(decision = {}, opts = {}) {
  const normalizedDecision = normalizeMemoryAdmissionDecision(decision);
  const createdAt = trimText(opts.createdAt, normalizedDecision.createdAt || nowIso());
  const receiptKind = normalizedDecision.receiptKind || (
    normalizedDecision.decision === 'allow'
      ? 'memory_admission_receipt'
      : normalizedDecision.decision === 'review'
        ? 'memory_review_receipt'
        : normalizedDecision.decision === 'quarantine'
          ? 'memory_quarantine_receipt'
          : 'memory_rejection_receipt'
  );
  const receiptId = trimText(opts.receiptId, normalizedDecision.receiptId || `madm_receipt_${crypto.createHash('sha1').update([
    normalizedDecision.admissionId,
    normalizedDecision.workspaceId,
    normalizedDecision.decision,
    createdAt,
  ].join('|'), 'utf8').digest('hex').slice(0, 16)}`);

  return {
    receiptId,
    receiptKind,
    receiptType: receiptKind.replace(/_receipt$/, '').replace(/_/g, '-'),
    decision: normalizedDecision.decision,
    status: normalizedDecision.decision === 'allow'
      ? 'admitted'
      : normalizedDecision.decision === 'review'
        ? 'review'
        : normalizedDecision.decision === 'quarantine'
          ? 'quarantined'
          : 'rejected',
    admissionId: trimText(normalizedDecision.admissionId),
    workspaceId: trimText(normalizedDecision.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    actor: trimText(normalizedDecision.actor),
    agentId: trimText(normalizedDecision.agentId),
    memoryDraftId: trimText(normalizedDecision.memoryDraftId),
    provenanceId: trimText(normalizedDecision.provenanceId),
    trustPolicyVersion: trimText(normalizedDecision.trustPolicyVersion),
    approvalId: trimText(normalizedDecision.approvalId),
    approvalStatus: trimText(normalizedDecision.approvalStatus, 'not_required'),
    reason: trimText(normalizedDecision.reason),
    riskScore: clampScore(normalizedDecision.riskScore, 0),
    canonical: normalizedDecision.decision === 'allow',
    reviewed: normalizedDecision.decision === 'review',
    quarantined: normalizedDecision.decision === 'quarantine',
    rejected: normalizedDecision.decision === 'reject',
    createdAt,
    metadata: clone(opts.metadata) || {},
  };
}

function normalizeMemoryAdmissionDecision(decision = {}) {
  const raw = isPlainObject(decision) ? decision : {};
  const normalizedDecision = normalizeDecision(raw.decision || raw.status || raw.decisionStatus || raw.outcome);
  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};
  const risk = isPlainObject(raw.risk) ? raw.risk : {};
  const request = isPlainObject(raw.request) ? raw.request : (isPlainObject(raw.admissionRequest) ? raw.admissionRequest : {});

  return {
    ok: Boolean(raw.ok ?? true),
    decision: normalizedDecision || 'review',
    allowed: normalizedDecision === 'allow',
    canApply: normalizedDecision === 'allow',
    canDryRun: normalizedDecision !== 'reject',
    requiresReview: normalizedDecision !== 'allow',
    quarantined: normalizedDecision === 'quarantine',
    rejected: normalizedDecision === 'reject',
    reason: trimText(raw.reason, 'Memory admission requires review'),
    risk: {
      level: trimText(risk.level, normalizedDecision === 'allow' ? 'low' : normalizedDecision === 'quarantine' ? 'high' : 'medium').toLowerCase(),
      score: clampScore(risk.score, clampScore(raw.riskScore, 0)),
    },
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean).map((value) => String(value)) : [],
    errors: Array.isArray(raw.errors) ? raw.errors.map((error) => (isPlainObject(error) ? { ...error } : { message: String(error) })) : [],
    request: clone(request),
    receipt: isPlainObject(raw.receipt) ? clone(raw.receipt) : null,
    metadata: {
      policyVersion: trimText(metadata.policyVersion, MEMORY_ADMISSION_POLICY_VERSION) || MEMORY_ADMISSION_POLICY_VERSION,
      workspaceId: trimText(metadata.workspaceId, trimText(raw.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID),
    },
    admissionId: trimText(raw.admissionId),
    workspaceId: trimText(raw.workspaceId, trimText(request.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID),
    actor: trimText(raw.actor, trimText(request.actor, '')),
    agentId: trimText(raw.agentId, trimText(request.agentId, '')),
    memoryDraftId: trimText(raw.memoryDraftId, trimText(request.memoryDraftId, '')),
    provenanceId: trimText(raw.provenanceId, trimText(request.provenanceId, '')),
    trustPolicyVersion: trimText(raw.trustPolicyVersion, trimText(request.trustPolicyVersion, MEMORY_ADMISSION_POLICY_VERSION) || MEMORY_ADMISSION_POLICY_VERSION),
    approvalId: trimText(raw.approvalId, trimText(request.approvalId, '')),
    approvalStatus: trimText(raw.approvalStatus, trimText(request.approvalStatus, 'not_required') || 'not_required'),
    receiptId: trimText(raw.receiptId, trimText(raw.receipt && raw.receipt.receiptId, '')),
    createdAt: trimText(raw.createdAt, trimText(request.createdAt, nowIso())),
    proposedMemory: clone(raw.proposedMemory ?? request.proposedMemory),
    requiredReview: normalizedDecision !== 'allow',
  };
}

function evaluateMemoryAdmission(input = {}, options = {}) {
  const built = buildMemoryAdmissionRequest(input, options);
  if (!built.ok) {
    return {
      ok: false,
      type: 'memory-admission-decision',
      warnings: built.warnings,
      errors: built.errors,
      request: built.request,
      decision: null,
      receipt: null,
    };
  }

  const request = built.request;
  const provenancePresent = Boolean(trimText(request.provenanceId));
  const approvalRequired = Boolean(request.approvalRequired ?? options.approvalRequired ?? false);
  const approvalStatus = trimText(request.approvalStatus, approvalRequired ? 'pending' : 'not_required');
  const riskScore = clampScore(request.riskScore, 0);
  const canonicalMutation = hasCanonicalMutation(request.proposedMemory);
  const quarantineSignal = isQuarantineSignal(request.proposedMemory);
  const highRisk = riskScore >= 85;
  const mediumRisk = riskScore >= 50;

  let decision = 'allow';
  let reason = 'provenance_present_low_risk';

  if (!provenancePresent) {
    decision = highRisk ? 'reject' : 'review';
    reason = highRisk ? 'missing_provenance_high_risk' : 'missing_provenance';
  }

  if (approvalStatus === 'rejected') {
    decision = 'reject';
    reason = 'approval_rejected';
  } else if (approvalStatus === 'cancelled' || approvalStatus === 'expired') {
    decision = highRisk ? 'quarantine' : 'review';
    reason = `approval_${approvalStatus}`;
  } else if (approvalRequired && approvalStatus !== 'approved') {
    decision = highRisk ? 'quarantine' : 'review';
    reason = 'approval_required';
  }

  if (quarantineSignal) {
    decision = 'quarantine';
    reason = 'quarantine_signal_detected';
  }

  if (highRisk && decision === 'allow') {
    decision = 'quarantine';
    reason = 'high_risk_memory_write';
  } else if (mediumRisk && decision === 'allow') {
    decision = 'review';
    reason = 'medium_risk_memory_write';
  }

  if (canonicalMutation && decision === 'allow' && !provenancePresent) {
    decision = 'review';
    reason = 'canonical_mutation_requires_provenance';
  }

  if (canonicalMutation && decision === 'allow' && approvalRequired && approvalStatus !== 'approved') {
    decision = 'review';
    reason = 'canonical_mutation_requires_approved_approval';
  }

  const normalizedDecision = normalizeMemoryAdmissionDecision({
    ok: true,
    decision,
    reason,
    risk: {
      level: highRisk ? 'high' : mediumRisk ? 'medium' : 'low',
      score: riskScore,
    },
    admissionId: request.admissionId,
    workspaceId: request.workspaceId,
    actor: request.actor,
    agentId: request.agentId,
    memoryDraftId: request.memoryDraftId,
    provenanceId: request.provenanceId,
    trustPolicyVersion: request.trustPolicyVersion,
    approvalId: request.approvalId,
    approvalStatus,
    createdAt: request.createdAt,
    proposedMemory: request.proposedMemory,
    request,
  });
  const receipt = buildMemoryAdmissionReceipt(normalizedDecision, options);
  normalizedDecision.receipt = receipt;
  normalizedDecision.receiptId = receipt.receiptId;
  normalizedDecision.allowed = normalizedDecision.decision === 'allow';
  normalizedDecision.canApply = normalizedDecision.decision === 'allow';
  normalizedDecision.canDryRun = normalizedDecision.decision !== 'reject';
  normalizedDecision.requiresReview = normalizedDecision.decision !== 'allow';
  normalizedDecision.quarantined = normalizedDecision.decision === 'quarantine';
  normalizedDecision.rejected = normalizedDecision.decision === 'reject';
  normalizedDecision.ok = true;
  normalizedDecision.request = clone(request);
  normalizedDecision.proposedMemory = clone(request.proposedMemory);
  normalizedDecision.metadata = {
    ...normalizedDecision.metadata,
    policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    workspaceId: request.workspaceId,
  };
  normalizedDecision.approvalStatus = approvalStatus;

  return {
    ok: true,
    type: 'memory-admission-decision',
    warnings: [],
    errors: [],
    request: clone(request),
    decision: normalizedDecision,
    receipt,
  };
}

module.exports = {
  MEMORY_ADMISSION_DECISIONS,
  MEMORY_ADMISSION_POLICY_VERSION,
  MEMORY_ADMISSION_RECEIPT_KINDS,
  buildMemoryAdmissionReceipt,
  buildMemoryAdmissionRequest,
  evaluateMemoryAdmission,
  normalizeMemoryAdmissionDecision,
  normalizeMemoryAdmissionRequest,
  validateMemoryAdmissionRequest,
};
