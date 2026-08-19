'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  NON_QUEUED_APPROVAL_STATUS,
  hasApprovalId,
  projectUploadAdmission,
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
