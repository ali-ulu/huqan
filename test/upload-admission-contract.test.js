'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  NON_QUEUED_APPROVAL_STATUS,
  hasApprovalId,
  projectUploadAdmission,
  buildUploadResponse,
  UPLOAD_STATUSES,
} = require('../lib/http/upload-admission-contract');

function reviewAdmission(overrides = {}) {
  return {
    outcome: 'review',
    reason: 'approval_required',
    approvalStatus: 'pending',
    receiptId: 'madm_test',
    receipt: {
      approvalId: '',
      approvalStatus: 'pending',
      receiptKind: 'memory_review_receipt',
    },
    ...overrides,
  };
}

test('projects non-queued upload review as explicit not_queued without mutating receipt state', () => {
  const input = reviewAdmission();
  const projected = projectUploadAdmission(input);

  assert.equal(projected.approvalStatus, NON_QUEUED_APPROVAL_STATUS);
  assert.equal(projected.receipt.approvalStatus, 'pending');
  assert.equal(projected.receipt.approvalId, '');
  assert.equal(input.approvalStatus, 'pending');
});

test('preserves an admission that has a real approval id', () => {
  const input = reviewAdmission({ approvalId: 'approval-1' });
  assert.equal(hasApprovalId(input), true);
  assert.strictEqual(projectUploadAdmission(input), input);
});

test('preserves non-review and already projected admissions', () => {
  const allow = reviewAdmission({ outcome: 'allow', approvalStatus: 'approved' });
  const projected = reviewAdmission({ approvalStatus: NON_QUEUED_APPROVAL_STATUS });

  assert.strictEqual(projectUploadAdmission(allow), allow);
  assert.strictEqual(projectUploadAdmission(projected), projected);
});

// The admission has always said not_queued, but the envelope around it read
// ok:true — so the one path where nothing was written and nothing was queued
// was indistinguishable from a successful upload for any client checking
// `ok` or the HTTP status (#1990).
test('a review-only upload does not report ok', () => {
  const response = buildUploadResponse(0, reviewAdmission());

  assert.equal(response.ok, false, 'nothing was written and nothing was queued');
  assert.equal(response.status, UPLOAD_STATUSES.NOT_QUEUED);
  assert.equal(response.learned, 0);
  assert.equal(response.admission.approvalStatus, NON_QUEUED_APPROVAL_STATUS);
  assert.equal(response.admission.receipt.approvalStatus, 'pending');
});

test('a queued review reports the review status rather than success', () => {
  const response = buildUploadResponse(0, reviewAdmission({ approvalId: 'approval-1' }));

  assert.equal(response.ok, false);
  assert.equal(response.status, UPLOAD_STATUSES.REVIEW);
});

test('an upload that became memory still reports ok', () => {
  const response = buildUploadResponse(3, reviewAdmission({ outcome: 'allow', approvalStatus: 'approved' }));

  assert.equal(response.ok, true);
  assert.equal(response.status, UPLOAD_STATUSES.LEARNED);
  assert.equal(response.learned, 3);
});

test('an upload with no admission at all still reports ok', () => {
  const response = buildUploadResponse(1, null);

  assert.equal(response.ok, true);
  assert.equal(response.status, UPLOAD_STATUSES.LEARNED);
  assert.equal(response.admission, null);
});
