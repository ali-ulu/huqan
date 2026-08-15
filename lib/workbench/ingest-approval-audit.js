'use strict';

// Audit evidence for the V4-B2B ingest approval path (#769).
//
// The action owner finalizes a durable approval and receipt, and on the
// approved path the ingest capability has already mutated the Graph by then.
// The final audit append used to be best-effort: every failure was swallowed
// into an empty auditRef and the caller returned an ordinary 200, so a
// committed mutation with no audit trail was reported as fully evidenced.
//
// Audit persistence is part of completion here. This module owns both halves
// of that: the append that reports whether the evidence is durable, and the
// deterministic state returned when it is not.

/**
 * Appends the final audit event and says whether the evidence is durable.
 *
 * The raw error never leaves this function; only a bounded reason does. A
 * missing auditId is the same gap as a throw -- there is nothing to cite
 * later either way.
 */
function recordAuditEvidence(recordAudit, approval, receipt, result) {
  try {
    const recorded = recordAudit(approval, receipt, result);
    const auditRef = recorded && typeof recorded === 'object' && typeof recorded.auditId === 'string'
      ? recorded.auditId.trim()
      : '';
    return auditRef ? { ok: true, auditRef } : { ok: false, reason: 'audit_reference_missing' };
  } catch (error) {
    console.error('[ingest-approval-audit] failed:', error);
    return { ok: false, reason: 'audit_append_failed' };
  }
}

/**
 * The state for "the durable part happened, the evidence did not".
 *
 * Not an ordinary success, and not a retryable failure: re-running an approved
 * ingest risks a duplicate write, the same no-retry rule the uncertain-outcome
 * path already follows. What the operator gets is the identifier pair needed
 * to reconcile by hand, and no raw plugin error.
 */
function auditEvidenceGap({ approval, receipt, committed, reason, message }) {
  return {
    status: 409,
    json: {
      ok: false,
      status: 'reconciliation_required',
      error: { code: 'AUDIT_EVIDENCE_MISSING', message },
      reconciliation: {
        state: reason,
        approvalId: (approval && approval.id) || '',
        receiptId: receipt.receiptId || '',
        decision: receipt.decision || '',
        actionOutcome: receipt.actionOutcome || '',
        committed,
        retry: false,
      },
    },
  };
}

/**
 * Append the audit event and hand back either its reference or the
 * reconciliation state that replaces the caller's success response.
 */
function auditOrGap(recordAudit, { approval, receipt, result, committed, message }) {
  const audit = recordAuditEvidence(recordAudit, approval, receipt, result);
  if (audit.ok) return { auditRef: audit.auditRef, gap: null };
  return {
    auditRef: '',
    gap: auditEvidenceGap({ approval, receipt, committed, reason: audit.reason, message }),
  };
}

module.exports = { recordAuditEvidence, auditEvidenceGap, auditOrGap };
