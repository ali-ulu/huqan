// The memory admission gate: evaluates one memory write into allow, review,
// quarantine or reject, with its receipt. The vocabulary, request handling and
// receipt/decision normalisation live in memory-admission-gate-*.js (#2184).

const { DECISION_SEVERITY, MEMORY_ADMISSION_DECISIONS, MEMORY_ADMISSION_POLICY_VERSION, MEMORY_ADMISSION_RECEIPT_KINDS, clampScore, clone, trimText } = require('./memory-admission-gate-contract');
const { buildMemoryAdmissionRequest, hasCanonicalMutation, isExpiredAtAdmission, isQuarantineSignal, normalizeMemoryAdmissionRequest, validateMemoryAdmissionRequest } = require('./memory-admission-gate-request');
const { buildMemoryAdmissionReceipt, normalizeMemoryAdmissionDecision } = require('./memory-admission-gate-receipt');

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

  const signals = [];

  if (!provenancePresent) {
    signals.push({
      decision: highRisk ? 'reject' : 'review',
      reason: highRisk ? 'missing_provenance_high_risk' : 'missing_provenance',
    });
  }

  if (highRisk) {
    signals.push({ decision: 'quarantine', reason: 'high_risk_memory_write' });
  } else if (mediumRisk) {
    signals.push({ decision: 'review', reason: 'medium_risk_memory_write' });
  }

  if (approvalStatus === 'rejected') {
    signals.push({ decision: 'reject', reason: 'approval_rejected' });
  } else if (approvalStatus === 'cancelled' || approvalStatus === 'expired') {
    signals.push({ decision: highRisk ? 'quarantine' : 'review', reason: `approval_${approvalStatus}` });
  } else if (approvalRequired && approvalStatus !== 'approved') {
    signals.push({ decision: highRisk ? 'quarantine' : 'review', reason: 'approval_required' });
  }

  if (canonicalMutation && !provenancePresent) {
    signals.push({ decision: 'review', reason: 'canonical_mutation_requires_provenance' });
  }

  if (canonicalMutation && approvalRequired && approvalStatus !== 'approved') {
    signals.push({ decision: 'review', reason: 'canonical_mutation_requires_approved_approval' });
  }

  if (quarantineSignal) {
    signals.push({ decision: 'quarantine', reason: 'quarantine_signal_detected' });
  }

  // A write whose shelf life has already run out cannot become institutional
  // memory: there is no window in which it would be authoritative. Rejecting it
  // here is cheaper than admitting it and degrading it on every future read.
  if (isExpiredAtAdmission(request)) {
    signals.push({ decision: 'reject', reason: 'expired_before_admission' });
  }

  if (signals.length === 0) signals.push({ decision: 'allow', reason: 'provenance_present_low_risk' });
  const strictest = signals.reduce((current, candidate) => (
    DECISION_SEVERITY[candidate.decision] >= DECISION_SEVERITY[current.decision] ? candidate : current
  ));
  const { decision, reason } = strictest;

  const normalizedDecision = normalizeMemoryAdmissionDecision({
    ok: true,
    decision,
    reason,
    signals,
    risk: {
      level: require('./risk-scale').riskLevelForScore(riskScore),
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
  // normalizeMemoryAdmissionDecision already derived the decision booleans,
  // request projection, policy/workspace metadata and approval status from the
  // exact request above. Only the newly materialized receipt is new state here.
  normalizedDecision.receipt = receipt;
  normalizedDecision.receiptId = receipt.receiptId;

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
