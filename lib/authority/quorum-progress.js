'use strict';

/**
 * N-of-M quorum progress for the approval authority API responses (#4215).
 *
 * `authority-service.js` built the same quorum shape inline in three places --
 * the queue listing, the single-approval view, and the pending branch of the
 * decision lookup -- each time deciding independently whether the approval
 * named eligible approvers. One helper owns that shape so the three views
 * cannot drift.
 *
 * Returns the extra fields only: for a 1-of-1 tool the object is empty, and
 * for an N-of-M tool it carries the required count, the distinct votes
 * received, and how many of the named approvers have not yet voted.
 */

const { quorumProgress } = require('./approval-view');
const { quorumRequiredFor, eligibleVotersRemaining } = require('../approval-rbac');

function quorumExtra(rbacPolicy, approval) {
  const required = quorumRequiredFor(rbacPolicy, approval.tool);
  if (required <= 1) return {};
  const progress = quorumProgress(approval.votes || [], required, approval.eligibleApprovers);
  const extra = { quorum: { required, received: progress.received, approverIds: progress.approverIds } };
  if (Array.isArray(approval.eligibleApprovers)) {
    const remaining = eligibleVotersRemaining(rbacPolicy, approval.eligibleApprovers, progress.approverIds);
    extra.eligibleVotersRemaining = remaining.length;
  }
  return extra;
}

module.exports = { quorumExtra };