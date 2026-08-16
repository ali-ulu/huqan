'use strict';

/**
 * Retry classification for the bounded A2A exchange (P0-F).
 *
 * ## The question this answers
 *
 * Not "should you retry" but "**is it safe to retry**". Those are different, and
 * conflating them is how at-most-once systems quietly become at-least-once.
 *
 * `lib/a2a/bounded-exchange.js` verifies first, reserves the replay key second,
 * and runs the effect third. So a refusal is safe to retry exactly when it
 * happened *before* the reservation: nothing was recorded, no effect ran, and
 * resending cannot cause a second one. Once the reservation exists, the request
 * is accounted for whether or not the caller ever saw the answer, and resending
 * is not a recovery strategy -- looking the task up is (P0-E).
 *
 * A retryable answer is not necessarily a useful one. Most pre-reservation
 * refusals are deterministic verification failures that will fail identically
 * forever. `safeToRetry: true` means "resending cannot double an effect", not
 * "resending might work". Callers that treat it as the latter waste requests;
 * callers that treat `false` as the former cause duplicates. Only one of those
 * is a correctness bug, which is why the flag is named for safety.
 *
 * ## Why this is a denylist with a fail-closed default
 *
 * Two reason codes can be returned at or after the reservation:
 *
 *   `replay_detected`     - the reservation already existed.
 *   `verification_failed` - the evaluator's catch-all. It is returned when
 *                           something threw, and the effect throwing is exactly
 *                           one of the ways that happens. The reservation may
 *                           be standing with no completion.
 *
 * Everything else in the evaluator's vocabulary is a verification refusal
 * decided before the reserve call. Rather than enumerate ~40 such codes and
 * risk a new one defaulting to safe, `classifyEvaluatorReason` marks an
 * *unrecognised shape* as unsafe: a missing or non-string reason is treated as
 * possibly-reserved. The denylist is small and the default is closed.
 */

/**
 * Evaluator reasons that may have reserved. Resending after one of these risks
 * a second effect, or misreads an accounted-for exchange as never having
 * happened.
 */
const NON_RETRYABLE_EVALUATOR_REASONS = Object.freeze([
  'replay_detected',
  'verification_failed',
]);

/**
 * Classify an evaluator refusal.
 *
 * @param {string} reason
 * @returns {boolean} true only when the refusal provably precedes the reservation
 */
function classifyEvaluatorReason(reason) {
  if (typeof reason !== 'string' || reason.length < 1) return false;
  return !NON_RETRYABLE_EVALUATOR_REASONS.includes(reason);
}

/**
 * Route-level refusals -- wrong method, unreadable body, non-canonical
 * workspace -- are decided before the evaluator is called at all, so no
 * reservation can exist. This is a structural fact about where the route
 * returns, not a property of the reason string, which is why it is a separate
 * function rather than more entries in a table.
 */
function classifyTransportRefusal() {
  return true;
}

module.exports = Object.freeze({
  NON_RETRYABLE_EVALUATOR_REASONS,
  classifyEvaluatorReason,
  classifyTransportRefusal,
});
