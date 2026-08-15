'use strict';

const { readReceiptById } = require('./receipt/receipt-read-index');

function approvalExecutionEvidence(graph, result) {
  const admission = result?.data?.admission || result?.meta?.admission || null;
  const receipt = admission?.receipt || result?.data?.receipt || result?.receipt || null;
  if (!receipt || typeof receipt !== 'object' || !String(receipt.receiptId || '').trim()) return null;

  const read = readReceiptById(graph, receipt.receiptId, {
    workspaceId: receipt.workspaceId || admission?.workspaceId || 'default',
  });
  return {
    receipt,
    refs: {
      receiptId: receipt.receiptId,
      auditId: read?.auditEvent?.auditId || null,
      candidateId: receipt.memoryDraftId || admission?.memoryDraftId || null,
      provenanceId: receipt.provenanceId || admission?.provenanceId || result?.meta?.provenance?.provenanceId || null,
    },
  };
}

function idempotentApprovalDecision(approval, decision) {
  return {
    ok: true,
    type: 'approval',
    data: {
      approval, decision, executed: false, idempotent: true, result: null,
      receipt: approval.context?.receipt || null,
      refs: approval.context?.executionRefs || null,
    },
    evidence: [], error: null, meta: { idempotent: true },
  };
}

function finalizeApprovalExecution({ store, approvalId, reason, graph, result }) {
  const executionEvidence = approvalExecutionEvidence(graph, result);
  if (!executionEvidence) return { code: 'APPROVAL_RECEIPT_NOT_MATERIALIZED' };
  const finalized = store.finalizeToolApprovalWithReceipt(approvalId, {
    expectedStatus: 'executing', decision: 'approved', reason,
    receipt: executionEvidence.receipt,
    contextPatch: { executionRefs: executionEvidence.refs },
  });
  return { approval: finalized?.approval || null, executionEvidence };
}

module.exports = { idempotentApprovalDecision, finalizeApprovalExecution };
