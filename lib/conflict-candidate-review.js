'use strict';

/**
 * Human review verdict on a conflict candidate (#2794).
 *
 * lib/conflict-detector.js's routeCandidateClaim() queues a real conflict
 * (`conflict.conflict === true`, e.g. an agent-vs-agent or agent-vs-graph
 * relation clash) as a candidate claim with `status: 'pending'`,
 * `recommendation: 'flag'`. Nothing resolves it: lib/hypothesis-review.js
 * reviews hypothesis-engine candidates only (`conflict: null`), never these.
 * Once lib/claim-read.js's readClaim() (#2788) starts returning
 * `behavior: 'block'` for HIGH/CRITICAL-risk readers hitting a live contest,
 * that block never clears for a real conflict candidate -- this module is
 * the one place a person's verdict on the *contest itself* enters the
 * system, mirroring hypothesis-review.js's shape and constraints.
 *
 * ## A verdict on the contest, not an automatic winner
 *
 * #2788's own design note (issuecomment-5784967135) is explicit that this
 * system never auto-picks a winner between two claims -- `recommendation`
 * stays `'flag'` for a human, both sides' evidence is carried forward. This
 * review function keeps that: reviewing a conflict candidate records that a
 * human looked at it and decided `accepted` ("the challenger's claim is
 * correct") or `rejected` ("the existing canonical edge stands, this
 * challenge doesn't hold up") as an audit fact, but writes no node or edge
 * either way -- same posture as hypothesis-review.js's "accept is a verdict
 * on the diagnosis, not on an edge". Promoting an accepted challenger into
 * canonical truth is a separate, ordinary canonical write (through the
 * normal admission-gated path), not something reviewing a contest implies.
 * What this function does guarantee: once reviewed, the candidate no longer
 * matches lib/contested-read-policy.js's isContestingCandidate() (it already
 * excludes `accepted`/`rejected` status), so a target that was blocked opens
 * back up to its last canonical value on the next read.
 *
 * ## The status values are a contract
 *
 * Same contract as hypothesis-review.js: `accepted` / `rejected` are not
 * free to drift, because lib/contested-read-policy.js's
 * NOT_CONTESTED_CANDIDATE_STATUSES depends on exactly these two strings.
 */

const { appendReviewAuditEvent } = require('./hypothesis-review-audit');
const { AUDIT_EVENTS } = require('./audit-log');

const REVIEWED_STATUSES = Object.freeze(new Set(['accepted', 'rejected']));
const DECISIONS = Object.freeze({ accept: 'accepted', reject: 'rejected' });

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function coerceText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** True iff `candidate` came out of conflict-detector.js with a real, detected conflict. */
function isConflictCandidate(candidate) {
  return candidate?.conflict?.conflict === true;
}

/**
 * @param {object} kernel
 * @param {{candidateId: string, decision: string, reviewer?: string, workspaceId?: string}} input
 * @returns {{candidateId: string, conflictType: string, previousStatus: string, status: string, reviewedBy: string, reviewedAt: string, canonicalWrite: false}}
 * @throws on an unknown id, a candidate with no real conflict, an already-reviewed candidate, or an unrecognised decision.
 */
function reviewConflictCandidate(kernel, input = {}) {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const candidateId = coerceText(input.candidateId, '');
  if (!candidateId) {
    throw fail('CONFLICT_REVIEW_UNKNOWN_CANDIDATE', 'A candidateId is required.');
  }

  const status = DECISIONS[coerceText(input.decision, '').toLowerCase()];
  if (!status) {
    throw fail(
      'CONFLICT_REVIEW_INVALID_DECISION',
      `Unrecognised review decision: ${String(input.decision)}. Use accept or reject.`,
    );
  }

  const candidate = (kernel.getCandidateClaims({ workspaceId }) || [])
    .find(item => item.candidateId === candidateId);
  if (!candidate) {
    throw fail(
      'CONFLICT_REVIEW_UNKNOWN_CANDIDATE',
      `No candidate claim ${candidateId} in workspace ${workspaceId}.`,
    );
  }

  if (!isConflictCandidate(candidate)) {
    throw fail(
      'CONFLICT_REVIEW_NOT_A_CONFLICT',
      `${candidateId} carries no detected conflict; this command reviews conflict candidates only.`,
    );
  }

  if (REVIEWED_STATUSES.has(candidate.status)) {
    throw fail(
      'CONFLICT_REVIEW_ALREADY_REVIEWED',
      `${candidateId} was already reviewed (${candidate.status}); a verdict is not silently overwritten.`,
    );
  }

  const reviewedBy = coerceText(input.reviewer, 'cli:conflict-review');
  const reviewedAt = new Date().toISOString();
  const previousStatus = coerceText(candidate.status, 'pending');

  // `recommendation` is what the engine said ('flag'); the review records
  // what the person said. They are separate facts, so the verdict never
  // rewrites it -- same rule hypothesis-review.js follows.
  kernel.addCandidateClaim({
    ...candidate,
    status,
    reviewedBy,
    reviewedAt,
  }, { workspaceId });

  const conflictType = candidate.conflict?.type || '';
  appendReviewAuditEvent(kernel, {
    eventType: status === 'accepted' ? AUDIT_EVENTS.CLAIM_ACCEPTED : AUDIT_EVENTS.CLAIM_REJECTED,
    targetType: 'candidate_claim',
    targetId: candidateId,
    details: {
      candidateId,
      conflictType,
      previousStatus,
      status,
      reviewedBy,
      recommendation: candidate.recommendation,
      // Stated rather than implied: a reader of the trail should not have to
      // infer that resolving a contest left the canonical graph untouched.
      canonicalWrite: false,
    },
  }, candidate.provenance || null, workspaceId);

  return {
    candidateId,
    conflictType,
    previousStatus,
    status,
    reviewedBy,
    reviewedAt,
    canonicalWrite: false,
  };
}

module.exports = {
  DECISIONS,
  isConflictCandidate,
  reviewConflictCandidate,
};
