'use strict';

/**
 * Human review verdict on a hypothesis candidate.
 *
 * The hypothesis engine only ever proposes: `--propose` queues high-severity
 * findings as candidate claims with `recommendation: 'flag'`, and nothing in
 * the existing conflict-detection path moves a flagged candidate off
 * `pending`. This module is the one place a person's verdict enters the
 * system, and it is deliberately narrow.
 *
 * ## Accept is a verdict on the diagnosis, not on an edge
 *
 * `ZAYIF_BAĞ` candidates carry a populated `proposedEdge`. Accepting one still
 * writes no canonical node or edge: the hypothesis says "this link looks
 * weak", so agreeing with it is agreeing with the diagnosis, not asking for
 * the link to be written. Every rule type behaves identically here, which is
 * what keeps "the engine only proposes, never writes" true end to end.
 *
 * ## The status values are a contract
 *
 * `accepted` / `rejected` are the input to the per-rule feedback counter that
 * closes the learning loop. They are not free to drift.
 */

const HYPOTHESIS_SOURCE_TYPE = 'hypothesis-engine';
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

/** Claims are built as `[TYPE] gerekçe`; the tag is the rule that produced it. */
function ruleTypeFromClaim(claim) {
  const match = String(claim || '').match(/^\[([^\]]+)\]/);
  return match ? match[1] : '';
}

function isHypothesisCandidate(candidate) {
  return candidate?.provenance?.sourceType === HYPOTHESIS_SOURCE_TYPE;
}

/**
 * @param {object} kernel
 * @param {{candidateId: string, decision: string, reviewer?: string, workspaceId?: string}} input
 * @returns {{candidateId: string, ruleType: string, previousStatus: string, status: string, reviewedBy: string, reviewedAt: string, canonicalWrite: false}}
 * @throws on an unknown id, a foreign source, an already-reviewed candidate, or an unrecognised decision.
 */
function reviewHypothesisCandidate(kernel, input = {}) {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const candidateId = coerceText(input.candidateId, '');
  if (!candidateId) {
    throw fail('HYPOTHESIS_REVIEW_UNKNOWN_CANDIDATE', 'A candidateId is required.');
  }

  const status = DECISIONS[coerceText(input.decision, '').toLowerCase()];
  if (!status) {
    throw fail(
      'HYPOTHESIS_REVIEW_INVALID_DECISION',
      `Unrecognised review decision: ${String(input.decision)}. Use --accept or --reject.`,
    );
  }

  const candidate = (kernel.getCandidateClaims({ workspaceId }) || [])
    .find(item => item.candidateId === candidateId);
  if (!candidate) {
    throw fail(
      'HYPOTHESIS_REVIEW_UNKNOWN_CANDIDATE',
      `No candidate claim ${candidateId} in workspace ${workspaceId}.`,
    );
  }

  if (!isHypothesisCandidate(candidate)) {
    throw fail(
      'HYPOTHESIS_REVIEW_FOREIGN_SOURCE',
      `${candidateId} was not produced by the hypothesis engine; this command reviews hypothesis candidates only.`,
    );
  }

  if (REVIEWED_STATUSES.has(candidate.status)) {
    throw fail(
      'HYPOTHESIS_REVIEW_ALREADY_REVIEWED',
      `${candidateId} was already reviewed (${candidate.status}); a verdict is not silently overwritten.`,
    );
  }

  const reviewedBy = coerceText(input.reviewer, 'cli:hypotheses-review');
  const reviewedAt = new Date().toISOString();
  const previousStatus = coerceText(candidate.status, 'pending');

  // `recommendation` is what the engine said; the review records what the
  // person said. They are separate facts, so the verdict never rewrites it.
  kernel.addCandidateClaim({
    ...candidate,
    status,
    reviewedBy,
    reviewedAt,
  }, { workspaceId });

  const ruleType = ruleTypeFromClaim(candidate.claim);
  kernel._appendAuditEvent({
    eventType: status === 'accepted' ? 'CLAIM_ACCEPTED' : 'CLAIM_REJECTED',
    targetType: 'candidate_claim',
    targetId: candidateId,
    details: {
      candidateId,
      ruleType,
      previousStatus,
      status,
      reviewedBy,
      recommendation: candidate.recommendation,
      // Stated rather than implied: a reader of the trail should not have to
      // infer that an accepted hypothesis left the canonical graph untouched.
      canonicalWrite: false,
    },
  }, candidate.provenance || null, workspaceId);

  return {
    candidateId,
    ruleType,
    previousStatus,
    status,
    reviewedBy,
    reviewedAt,
    canonicalWrite: false,
  };
}

module.exports = {
  DECISIONS,
  HYPOTHESIS_SOURCE_TYPE,
  reviewHypothesisCandidate,
  ruleTypeFromClaim,
};
