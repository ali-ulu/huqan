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

const UPLOAD_STATUSES = Object.freeze({
  LEARNED: 'learned',
  REVIEW: 'review',
  NOT_QUEUED: NON_QUEUED_APPROVAL_STATUS,
});

/**
 * Envelope for a /upload (or /yukle) response.
 *
 * The admission already told the truth: outcome 'review', approvalStatus
 * 'not_queued', graphWrite false. The envelope around it did not — it read
 * `ok: true` with `learned: 0`, which every client-side success check treats as
 * a completed upload, so the one path where nothing was written and nothing was
 * queued looked identical to a successful one (#1990).
 *
 * `ok` now means what a caller reads it to mean: the proposal became memory.
 * `status` names which of the three outcomes happened, so a client does not
 * have to reach into `admission` to find out.
 */
function buildUploadResponse(learned, admission) {
  const projected = projectUploadAdmission(admission);
  const isReview = Boolean(projected && typeof projected === 'object' && projected.outcome === 'review');
  let status = UPLOAD_STATUSES.LEARNED;
  if (isReview) {
    status = projected.approvalStatus === NON_QUEUED_APPROVAL_STATUS
      ? UPLOAD_STATUSES.NOT_QUEUED
      : UPLOAD_STATUSES.REVIEW;
  }

  return {
    ok: status === UPLOAD_STATUSES.LEARNED,
    status,
    learned,
    admission: projected,
  };
}

module.exports = {
  NON_QUEUED_APPROVAL_STATUS,
  UPLOAD_STATUSES,
  hasApprovalId,
  projectUploadAdmission,
  buildUploadResponse,
};
