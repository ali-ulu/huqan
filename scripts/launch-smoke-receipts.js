'use strict';

function receiptSemantics(receipt) {
  return {
    receiptKind: receipt?.receiptKind || null,
    receiptType: receipt?.receiptType || null,
    decision: receipt?.decision || null,
    status: receipt?.status || null,
    workspaceId: receipt?.workspaceId || null,
    approvalStatus: receipt?.approvalStatus || null,
    canonical: receipt?.canonical === true,
    reviewed: receipt?.reviewed === true,
    quarantined: receipt?.quarantined === true,
    rejected: receipt?.rejected === true,
    trustPolicyVersion: receipt?.trustPolicyVersion || null,
  };
}

function validateApprovedReceipt(label, receipt, approvalId, refs = null, ctx = null) {
  const fail = ctx && typeof ctx.fail === 'function' ? ctx.fail : (message) => { throw new Error(message); };
  const workspaceId = ctx && typeof ctx.workspaceId === 'string' ? ctx.workspaceId : null;
  if (!receipt || typeof receipt !== 'object' || typeof receipt.receiptId !== 'string' || !receipt.receiptId) {
    fail(`${label} did not return a real receiptId`);
    return null;
  }
  const semantics = receiptSemantics(receipt);
  const expected = semantics.receiptKind === 'memory_admission_receipt'
    && semantics.receiptType === 'memory-admission'
    && semantics.decision === 'allow'
    && semantics.status === 'admitted'
    && semantics.workspaceId === workspaceId
    && semantics.approvalStatus === 'approved'
    && semantics.canonical === true
    && semantics.reviewed === false
    && semantics.quarantined === false
    && semantics.rejected === false
    && typeof semantics.trustPolicyVersion === 'string'
    && semantics.trustPolicyVersion.length > 0
    && receipt.approvalId === approvalId
    && typeof receipt.provenanceId === 'string'
    && receipt.provenanceId.length > 0;
  if (!expected) {
    fail(`${label} receipt does not represent the approved canonical admission: ${JSON.stringify(receipt).slice(-2500)}`);
    return null;
  }
  if (refs?.provenanceId && refs.provenanceId !== receipt.provenanceId) {
    fail(`${label} receipt provenanceId contradicts approval execution refs`);
    return null;
  }
  return semantics;
}

function cliVerifyIsVerified(envelope) {
  return /Verify:\s*verified\b/i.test(String(envelope?.data?.output || ''));
}

function mcpVerifyIsVerified(surface) {
  const status = String(surface?.data?.status || '').toLowerCase();
  return status === 'verified' || status === 'dogrulandi';
}

module.exports = {
  receiptSemantics,
  validateApprovedReceipt,
  cliVerifyIsVerified,
  mcpVerifyIsVerified,
};
