'use strict';

/**
 * Bounded ingest-error recording for the company-brain / repo-memory plugins.
 *
 * Both plugins write to the same `kernel._companyIngestState` object and both
 * carried the same unbounded `ingestErrors.push(...)`. Nothing trimmed it, so
 * the array grew for the life of the process -- and it grows fastest in exactly
 * the situation nobody wants it to: an unreachable source, an expired
 * credential or a misconfigured repository adds one record per attempt. The
 * company-brain status endpoint then returned the whole array in a single
 * response.
 *
 * The array is kept as a ring buffer of the most recent entries, and a
 * monotonic total is recorded alongside it so capping never hides how many
 * failures actually happened.
 */

const MAX_INGEST_ERRORS = 200;
const DEFAULT_REPORTED_ERRORS = 20;

/**
 * Append one ingest error, dropping the oldest once the cap is reached.
 *
 * @param {{ingestErrors: object[], ingestErrorTotal?: number}} state
 * @param {string} sourceType
 * @param {*} message
 * @param {string} at ISO timestamp
 */
function recordIngestError(state, sourceType, message, at) {
  if (!Array.isArray(state.ingestErrors)) state.ingestErrors = [];
  state.ingestErrors.push({
    sourceType,
    message: String(message || 'unknown error'),
    at,
  });
  if (state.ingestErrors.length > MAX_INGEST_ERRORS) {
    state.ingestErrors.splice(0, state.ingestErrors.length - MAX_INGEST_ERRORS);
  }
  state.ingestErrorTotal = Number(state.ingestErrorTotal || 0) + 1;
}

/**
 * The reportable view of the recorded errors: newest first, bounded, and
 * honest about what was left out.
 *
 * @param {{ingestErrors?: object[], ingestErrorTotal?: number}} state
 * @param {number} [limit]
 * @returns {{ingestErrors: object[], ingestErrorTotal: number, ingestErrorsTruncated: boolean}}
 */
function summarizeIngestErrors(state, limit = DEFAULT_REPORTED_ERRORS) {
  const recorded = Array.isArray(state.ingestErrors) ? state.ingestErrors : [];
  const total = Number(state.ingestErrorTotal || 0) || recorded.length;
  return {
    // Newest first: the error an operator needs is the last one, and burying it
    // at the end of the array is what made the old response useless at volume.
    ingestErrors: recorded.slice(-limit).reverse(),
    ingestErrorTotal: total,
    ingestErrorsTruncated: total > Math.min(limit, recorded.length),
  };
}

module.exports = { MAX_INGEST_ERRORS, DEFAULT_REPORTED_ERRORS, recordIngestError, summarizeIngestErrors };
