'use strict';

/**
 * Bounded ingest-error recording for the company-brain / repo-memory plugins.
 *
 * Both plugins once wrote to the same kernel state object and both carried the
 * same unbounded `ingestErrors.push(...)`. The state is now owned by each plugin,
 * while this helper keeps each owner’s history bounded and safe for status
 * responses. An unreachable source, expired credential, or misconfigured
 * repository still adds one record per attempt, but never an unbounded payload.
 *
 * The array is kept as a ring buffer of the most recent entries, and a
 * monotonic total is recorded alongside it so capping never hides how many
 * failures actually happened.
 */

const MAX_INGEST_ERRORS = 200;
const DEFAULT_REPORTED_ERRORS = 20;
const MAX_INGEST_ERROR_MESSAGE = 512;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g;
const POSIX_PATH_PATTERN = /(?:^|[\s(])\/(?:[^\s/]+\/)+[^\s),;:!?]+/g;

function sanitizeIngestErrorMessage(message) {
  let text = String(message || 'unknown error');
  text = text.replace(URL_PATTERN, '[REDACTED_URL]');
  text = text.replace(WINDOWS_PATH_PATTERN, '[REDACTED_PATH]');
  text = text.replace(POSIX_PATH_PATTERN, (match) => match.startsWith('/')
    ? '[REDACTED_PATH]'
    : `${match[0]}[REDACTED_PATH]`);
  return text.slice(0, MAX_INGEST_ERROR_MESSAGE);
}

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
    message: sanitizeIngestErrorMessage(message),
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

module.exports = {
  MAX_INGEST_ERRORS,
  DEFAULT_REPORTED_ERRORS,
  MAX_INGEST_ERROR_MESSAGE,
  sanitizeIngestErrorMessage,
  recordIngestError,
  summarizeIngestErrors,
};
