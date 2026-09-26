// Memory admission receipt and decision normalisation, moved out of
// memory-admission-gate.js (#2184).

const crypto = require('crypto');

const { DEFAULT_WORKSPACE_ID, MEMORY_ADMISSION_POLICY_VERSION, clampScore, clone, isPlainObject, normalizeDecision, normalizeDecisionSignals, nowIso, trimText } = require('./memory-admission-gate-contract');

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
  const receiptId = trimText(opts.receiptId, normalizedDecision.receiptId || `madm_receipt_${crypto.createHash('sha256').update([
    normalizedDecision.admissionId,
    normalizedDecision.workspaceId,
    normalizedDecision.decision,
    createdAt,
  ].join('|'), 'utf8').digest('hex').slice(0, 32)}`);

  const metadata = clone(opts.metadata) || {};
  // F1a: surface the caller's declaration on the receipt when one was made.
  // Absent declarations leave metadata byte-identical to before, so existing
  // receipts and their hash chain are untouched.
  const declared = normalizedDecision.request ? normalizedDecision.request.declaredConfidence : undefined;
  if (typeof declared === 'number' && Number.isFinite(declared)) metadata.declaredConfidence = declared;
  // Same additive rule for the declared shelf life (and #2795's computed
  // horizon just below, lib/admission-horizon.js): the read side only honours what survives onto the receipt.
  const expiresAt = trimText(normalizedDecision.request ? normalizedDecision.request.expiresAt : '');
  if (expiresAt) metadata.expiresAt = expiresAt; require('./admission-horizon').applyReverificationHorizon(metadata, { expiresAt, riskScore: normalizedDecision.risk?.score, createdAt });
  const provenanceSource = trimText(normalizedDecision.request ? normalizedDecision.request.provenanceSource : '');
  if (provenanceSource) metadata.provenanceSource = provenanceSource;

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
    signals: clone(normalizedDecision.signals),
    riskScore: clampScore(normalizedDecision.riskScore, 0),
    canonical: normalizedDecision.decision === 'allow',
    reviewed: normalizedDecision.decision === 'review',
    quarantined: normalizedDecision.decision === 'quarantine',
    rejected: normalizedDecision.decision === 'reject',
    createdAt,
    metadata,
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
    signals: normalizeDecisionSignals(raw.signals),
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

module.exports = { buildMemoryAdmissionReceipt, normalizeMemoryAdmissionDecision };
