'use strict';

/**
 * The ingest-approval audit write, routed through the mutation admission seam.
 *
 * This is P1's **first real caller**. It was chosen for being the smallest and
 * most isolated of the 42 direct sink calls -- one write, one workspace, no
 * delegation -- so that the seam's API meets a production call site before the
 * large families are moved onto it. `docs/task-packs/p1b-gate2-hook-source-reality.md`
 * identified it as the clearest single bypass, which makes it the honest place
 * to start closing.
 *
 * ## Why the write moved out of server.js
 *
 * `ARCH-001`: `server.js` gains wiring and delegation only. The admission
 * context has to be built somewhere, and building it inline would have grown a
 * file already sitting at its `scripts/check-file-size.js` ceiling.
 *
 * ## Behaviour that had to be preserved exactly
 *
 * The previous call passed `{ workspaceId: snapshot.workspaceId }` straight to
 * the sink, where `normalizeAuditEvent` coerced a missing value to `default`.
 * The seam refuses an empty workspace, so the fallback is resolved *here*
 * instead -- to the same `default` the sink would have applied. The audit event
 * that gets written is byte-identical to the one written before; what changed is
 * that the workspace is now decided in the open rather than defaulted deep in
 * storage, which is what ADR-011 asks of a tenancy boundary.
 *
 * ## What a refusal means
 *
 * A refused admission throws, and that is deliberate rather than convenient:
 * `lib/workbench/ingest-approval-audit.js` already converts a throw into
 * `audit_append_failed` and then into the `AUDIT_EVIDENCE_MISSING`
 * reconciliation state -- "the durable part happened, the evidence did not",
 * explicitly non-retryable. That is exactly the right meaning for a refused
 * audit write, so the refusal joins an existing bounded path instead of
 * inventing a second one.
 */

const { absent } = require('../mutation-admission');

const DEFAULT_WORKSPACE = 'default';
const AUDIT_ACTION = 'graph.appendAuditEvent:ingest_approval';

/**
 * Why each identity field is absent at this call site.
 *
 * These are not placeholders. They are the source-level facts about this
 * caller, and they stay until identity actually reaches it. When enforcement is
 * switched on, "under what policy is this accepted as a system actor?" becomes
 * a decision someone makes here, with the reason already written down -- rather
 * than a claim someone invents to make a check pass.
 */
const ABSENCE_REASONS = Object.freeze({
  identityClaim: 'ingest approval decisions carry no identity claim; the approving actor is not modelled yet',
  delegationContext: 'no delegation chain reaches this write; the approval owner is the only authority',
  connectorContext: 'not reached through a connector; this is an internal approval outcome',
});

/**
 * @param {{ graph: object, admission: { admit: Function }, hashResult: Function, identityContext?: Function }} deps
 * @returns {(approval: object, receipt: object, result?: unknown) => object}
 */
function createIngestApprovalAuditWriter({ graph, admission, hashResult, ledger = null, identityContext = null }) {
  if (!graph || typeof graph.appendAuditEvent !== 'function') {
    throw new Error('an audit sink is required');
  }
  if (!admission || typeof admission.admit !== 'function') {
    throw new Error('the mutation admission seam is required');
  }
  if (typeof hashResult !== 'function') throw new Error('a result hasher is required');
  if (ledger !== null && (!ledger || typeof ledger.append !== 'function')) {
    throw new Error('ledger append seam is required when supplied');
  }

  return function recordIngestApprovalAudit(approval, receipt, result = null) {
    // The workspace comes from the immutable snapshot the action owner
    // validated, never from decision-request bytes.
    const snapshot = approval?.context?.snapshot || {};
    const resultRef = result ? hashResult(result) : '';
    const workspaceId = snapshot.workspaceId || DEFAULT_WORKSPACE;

    const auditEvent = () => graph.appendAuditEvent({
      eventType: receipt.decision === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
      targetType: 'ingest_approval',
      targetId: approval.id,
      details: {
        receipt,
        snapshotHash: snapshot.snapshotHash || '',
        pluginResultRef: resultRef,
        actionOutcome: receipt.actionOutcome || '',
        executionGuarantee: 'bounded_action_outcome',
      },
    }, { workspaceId });

    const evidenceDecision = receipt.decision === 'approved' ? 'allow' : 'block';
    const evidenceOperationId = `trust-evidence:ingest-approval:${String(approval.id || '').trim()}`;
    const evidenceEvent = {
      workspaceId,
      operationId: evidenceOperationId,
      decision: evidenceDecision,
      reason: receipt.reason || '',
      actionFingerprint: hashResult(JSON.stringify({
        approvalId: approval.id,
        snapshotHash: snapshot.snapshotHash || '',
        receiptId: receipt.receiptId || '',
      })),
      identityRef: receipt.agentId || '',
      identityHash: receipt.agentIdentityHash || '',
      authorityRef: receipt.actor || '',
      policyVersion: receipt.trustPolicyVersion || '',
      firewallVersion: receipt.firewallVersion || '',
      approvalRef: approval.id,
      executionOutcome: receipt.actionOutcome || (evidenceDecision === 'allow' ? 'pending' : 'not_attempted'),
      sourceRefs: snapshot.snapshotHash ? [`snapshot:${snapshot.snapshotHash}`] : [],
      provenanceRefs: receipt.provenanceId ? [receipt.provenanceId] : [],
      createdAt: receipt.createdAt || new Date().toISOString(),
      metadata: {
        approvalDecision: receipt.decision || '',
        receiptId: receipt.receiptId || '',
        pluginResultRef: resultRef,
      },
    };

    const writeEvidence = () => ledger
      ? ledger.append({ operationId: evidenceOperationId, event: evidenceEvent, mutate: auditEvent }).result
      : auditEvent();

    const declaredIdentityContext = typeof identityContext === 'function'
      ? identityContext({ approval, receipt, result, workspaceId })
      : {
          identityClaim: absent(ABSENCE_REASONS.identityClaim),
          delegationContext: absent(ABSENCE_REASONS.delegationContext),
          connectorContext: absent(ABSENCE_REASONS.connectorContext),
        };
    if (!declaredIdentityContext || typeof declaredIdentityContext !== 'object'
        || Array.isArray(declaredIdentityContext)) {
      const error = new Error('ingest approval audit identity context is invalid');
      error.code = 'MUTATION_ADMISSION_REFUSED';
      error.admissionReason = 'admission.context_invalid';
      throw error;
    }
    const outcome = admission.admit({
      workspaceId,
      action: AUDIT_ACTION,
      ...declaredIdentityContext,
    }, writeEvidence);

    if (!outcome.admitted) {
      const error = new Error(`ingest approval audit refused by admission: ${outcome.reason}`);
      error.code = 'MUTATION_ADMISSION_REFUSED';
      error.admissionReason = outcome.reason;
      throw error;
    }
    return outcome.result;
  };
}

module.exports = Object.freeze({
  ABSENCE_REASONS,
  AUDIT_ACTION,
  DEFAULT_WORKSPACE,
  createIngestApprovalAuditWriter,
});
