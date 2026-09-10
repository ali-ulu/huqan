'use strict';

/**
 * PR Guardian — derivation signal.
 *
 * A pull request may carry derivation records: claims that certain files are
 * the mechanical output of a recorded transform. This module re-runs those
 * transforms and reduces the result to the small summary the policy reads.
 *
 * Why the signal is computed here and consumed there: `evaluatePullRequest` is
 * a pure function over a snapshot, and the workflow that runs it checks out the
 * BASE tree on purpose so a pull request cannot supply its own copy of the
 * policy. Re-derivation needs file contents from both sides, which is I/O.
 * Keeping the I/O outside preserves both properties -- the policy stays pure,
 * and the code that judges the change still comes from base.
 *
 * The records themselves come from the pull request, so they are a claim by the
 * change under review about itself. That is exactly why they are re-run rather
 * than believed: a record cannot make its own diff pass, it can only offer a
 * prediction that this check either reproduces or does not.
 */

const { verifyDerivation } = require('../coder/verify-derivation');

/**
 * Outcomes that say we could not check the record, as opposed to saying the
 * record is wrong. The distinction is not cosmetic: `failed` sends a change to
 * review, and doing that for a reason that is about the reviewer rather than
 * the change is an accusation we have not earned.
 *
 * Found live rather than reasoned out. The pull request that first carried a
 * record produced it with a newer schema than `main` had, so the verifier
 * running from the base tree correctly answered SCHEMA_NOT_REDERIVABLE -- and
 * this summary called that a failure and sent the change to review. Every
 * schema bump would have done the same, for a reason that has nothing to do
 * with the code under review.
 */
const UNVERIFIABLE_REASONS = new Set(['SCHEMA_NOT_REDERIVABLE', 'VERIFIER_ERROR']);

const DERIVATION_STATUS = Object.freeze({
  NONE: 'none',
  VERIFIED: 'verified',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

/**
 * @param {object} input
 * @param {Array<{path: string, record: object}>} input.records records found in the change
 * @param {(path: string) => string|null} input.readBase base-side reader
 * @param {(path: string) => string|null} input.readHead head-side reader
 * @param {boolean} [input.complete] false when the record list could not be read in full
 */
function summarizeDerivations(input = {}) {
  const { records, readBase, readHead, complete = true } = input;

  // An unreadable record list is not evidence that there were none. Fail to
  // `unknown` so the gap is reported rather than read as a clean result.
  if (!Array.isArray(records) || complete !== true) {
    return {
      status: DERIVATION_STATUS.UNKNOWN,
      total: 0,
      verified: 0,
      failures: [],
      unverifiable: [],
      verifiedPaths: [],
    };
  }
  if (records.length === 0) {
    return {
      status: DERIVATION_STATUS.NONE,
      total: 0,
      verified: 0,
      failures: [],
      unverifiable: [],
      verifiedPaths: [],
    };
  }

  const failures = [];
  const unverifiable = [];
  const verifiedPaths = [];
  let verified = 0;

  for (const entry of records) {
    const where = String(entry?.path || '(unnamed record)');
    let verdict;
    try {
      verdict = verifyDerivation({ record: entry?.record, readBase, readHead });
    } catch (error) {
      unverifiable.push({ path: where, reason: 'VERIFIER_ERROR', detail: error.message });
      continue;
    }
    if (verdict.ok) {
      verified += 1;
      verifiedPaths.push(...verdict.verifiedPaths);
      continue;
    }
    const bucket = UNVERIFIABLE_REASONS.has(verdict.reason) ? unverifiable : failures;
    bucket.push({ path: where, reason: verdict.reason, detail: verdict.detail });
  }

  // Order matters: a real failure outranks an unverifiable record, so a change
  // cannot bury one bad derivation behind an unreadable one.
  const status = failures.length
    ? DERIVATION_STATUS.FAILED
    : (unverifiable.length ? DERIVATION_STATUS.UNKNOWN : DERIVATION_STATUS.VERIFIED);

  return {
    status,
    total: records.length,
    verified,
    failures,
    unverifiable,
    verifiedPaths: [...new Set(verifiedPaths)].sort(),
  };
}

/** Path convention for records committed alongside the change they describe. */
const DERIVATION_RECORD_PREFIX = '.huqan/derivations/';

function isDerivationRecordPath(filename) {
  const path = String(filename || '');
  return path.startsWith(DERIVATION_RECORD_PREFIX) && path.endsWith('.json');
}

module.exports = Object.freeze({
  DERIVATION_RECORD_PREFIX,
  UNVERIFIABLE_REASONS,
  DERIVATION_STATUS,
  isDerivationRecordPath,
  summarizeDerivations,
});
