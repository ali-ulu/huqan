'use strict';

/**
 * The CLI `conflicts review` command (#3187): the production caller
 * `lib/conflict-candidate-review.js` was waiting for.
 *
 * The sibling of `hypotheses review` in lib/cli-hypotheses.js, and deliberately
 * only that. `lib/contested-read-policy.js` already treats an accepted or
 * rejected candidate as no longer contesting a read, so the half of the loop
 * that consumes a verdict exists; what was missing was the step where a person
 * records it. This is that step, nothing more.
 *
 * ## Which reviewers may decide is stated, not implied
 *
 * The review decides whether a `block` clears, so "who may decide" must not be
 * an open question. `reviewConflictCandidate` records any named reviewer, and
 * `--reviewer` is optional, so on its own the CLI would accept an anonymous
 * verdict. `--reviewer` is therefore required here and the name must be a
 * non-empty token: an unnamed verdict is refused before it is written. Widening
 * this into a capability/allowlist check is a policy decision with its own
 * home, not something this command invents.
 *
 * ## The verdict writes no canonical edge
 *
 * The output says so explicitly. Accepting a conflict candidate is agreeing
 * with the challenge's diagnosis, not promoting it into canonical truth --
 * that stays an ordinary admission-gated write, exactly as
 * lib/conflict-candidate-review.js's header documents.
 */

const { reviewConflictCandidate } = require('./conflict-candidate-review');

const USAGE = 'conflicts review <candidateId> --accept|--reject --reviewer <id> [--workspace <id>]';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function formatConflictReviewResult(review) {
  const lines = [
    `Conflict review — ${review.candidateId}`,
    `  conflict type: ${review.conflictType || '(unknown)'}`,
    `  status: ${review.previousStatus} -> ${review.status}`,
    `  reviewed by: ${review.reviewedBy}`,
    '  Canonical graph unchanged: accepting a conflict verdict is a verdict on the contest, not a canonical edge.',
  ];
  // The verdict stands; a failed committed-audit record is disclosed, not
  // hidden behind a success line (#3187 review).
  if (review.warning) lines.push(`  warning: ${review.warning}`);
  return lines.join('\n');
}

/**
 * @param {object} kernel
 * @param {{candidateId?: string, decision?: string, reviewer?: string, workspaceId?: string}} args
 * @param {{json?: boolean, commitMutation?: () => string}} [opts]
 * @returns {string|{review: object}}
 */
function runCliConflicts(kernel, args = {}, opts = {}) {
  const reviewer = typeof args.reviewer === 'string' ? args.reviewer.trim() : '';
  // Checked before the review runs, so a missing reviewer never reaches the
  // write and never leaves a half-recorded verdict behind.
  if (!reviewer) {
    throw fail('CONFLICT_REVIEW_REVIEWER_REQUIRED', `A reviewer is required: ${USAGE}`);
  }

  const review = reviewConflictCandidate(kernel, {
    candidateId: args.candidateId,
    decision: args.decision,
    reviewer,
    workspaceId: args.workspaceId,
  });

  // The matching `committed` audit event for the gate's `attempted` one; its
  // failure is reported, not fatal, exactly as cli-hypotheses.js does.
  if (typeof opts.commitMutation === 'function') {
    const warning = opts.commitMutation();
    if (warning) review.warning = warning;
  }

  return opts.json === true || args.json === true ? { review } : formatConflictReviewResult(review);
}

module.exports = {
  USAGE,
  formatConflictReviewResult,
  runCliConflicts,
};
