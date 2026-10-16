'use strict';

// The unforgeable operator approval that releases a workflow review (#388).
// Moved out of workflow-agent.js (#2132) so the tool registry and the agent share
// one token: only createExternalReviewApproval can mint an object that passes.

const EXTERNAL_REVIEW_APPROVAL_TOKEN = Symbol('workflow-agent-external-review-approval');

function isExternalReviewApproved(approval) {
  return Boolean(
    approval
    && typeof approval === 'object'
    && approval[EXTERNAL_REVIEW_APPROVAL_TOKEN] === true
    && typeof approval.reason === 'string'
    && approval.reason.trim().length > 0
  );
}

function createExternalReviewApproval(reason) {
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new TypeError('createExternalReviewApproval(reason): reason must be a non-empty string');
  }
  return { [EXTERNAL_REVIEW_APPROVAL_TOKEN]: true, reason };
}

module.exports = { isExternalReviewApproved, createExternalReviewApproval };
