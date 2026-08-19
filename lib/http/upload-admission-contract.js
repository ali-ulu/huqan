'use strict';

const NON_QUEUED_APPROVAL_STATUS = 'not_queued';

function hasApprovalId(admission) {
  if (!admission || typeof admission !== 'object') return false;
  const directId = typeof admission.approvalId === 'string' ? admission.approvalId.trim() : '';
  const receiptId = admission.receipt && typeof admission.receipt === 'object'
    ? (typeof admission.receipt.approvalId === 'string' ? admission.receipt.approvalId.trim() : '')
    : '';
  return Boolean(directId || receiptId);
}

function projectUploadAdmission(admission) {
  if (!admission || typeof admission !== 'object') return admission;
  if (admission.outcome !== 'review'
    || admission.approvalStatus !== 'pending'
    || hasApprovalId(admission)) {
    return admission;
  }

  // The HTTP upload boundary does not persist an approval candidate. Keep the
  // signed/immutable receipt's pending decision state intact, but make the
  // transport admission explicit so clients do not mistake it for a queue.
  return {
    ...admission,
    approvalStatus: NON_QUEUED_APPROVAL_STATUS,
  };
}

module.exports = {
  NON_QUEUED_APPROVAL_STATUS,
  hasApprovalId,
  projectUploadAdmission,
};
