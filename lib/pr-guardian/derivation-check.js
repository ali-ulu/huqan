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
      verifiedPaths: [],
    };
  }
  if (records.length === 0) {
    return {
      status: DERIVATION_STATUS.NONE,
      total: 0,
      verified: 0,
      failures: [],
      verifiedPaths: [],
    };
  }

  const failures = [];
  const verifiedPaths = [];
  let verified = 0;

  for (const entry of records) {
    const where = String(entry?.path || '(unnamed record)');
    let verdict;
    try {
      verdict = verifyDerivation({ record: entry?.record, readBase, readHead });
    } catch (error) {
      // A verifier that throws has told us nothing about the change. Recording
      // it as a failure of the record would be a claim we did not establish.
      failures.push({ path: where, reason: 'VERIFIER_ERROR', detail: error.message });
      continue;
    }
    if (verdict.ok) {
      verified += 1;
      verifiedPaths.push(...verdict.verifiedPaths);
      continue;
    }
    failures.push({ path: where, reason: verdict.reason, detail: verdict.detail });
  }

  return {
    status: failures.length ? DERIVATION_STATUS.FAILED : DERIVATION_STATUS.VERIFIED,
    total: records.length,
    verified,
    failures,
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
  DERIVATION_STATUS,
  isDerivationRecordPath,
  summarizeDerivations,
});
