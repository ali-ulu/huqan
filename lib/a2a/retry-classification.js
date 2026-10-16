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
 * ## Why this is an allowlist with a fail-closed default
 *
 * Two reason codes can be returned at or after the reservation:
 *
 *   `replay_detected`     - the reservation already existed.
 *   `verification_failed` - the evaluator's catch-all. It is returned when
 *                           something threw, and the effect throwing is exactly
 *                           one of the ways that happens. The reservation may
 *                           be standing with no completion.
 *
 * Only explicitly known pre-reservation reasons are safe to retry. An unknown
 * string is unsafe as well: a new evaluator refusal must not become retryable
 * merely because it was omitted from a list.
 */

/**
 * Evaluator reasons known to happen before reservation. Only these refusals
 * can be retried without risking a second effect.
 */
const RETRYABLE_EVALUATOR_REASONS = Object.freeze([
  'consumer_invalid',
  'exchange_shape_invalid',
  'authority_invalid',
  'exchange_expired',
  'identity_invalid',
  'identity_binding_invalid',
  'delegation_chain_invalid',
  'delegation_invalid',
  'delegation_signature_invalid',
  'delegation_scope_escalation',
  'delegation_expired',
  'constraints_exceeded',
  'evidence_action_invalid',
  'evidence_receipt_invalid',
  'evidence_package_invalid',
  'evidence_package_authority_invalid',
  'evidence_refs_invalid',
  'evidence_package_binding_invalid',
  'evidence_receipt_authority_invalid',
  'route_receipt_invalid',
  'exchange_signature_invalid',
]);

/**
 * Classify an evaluator refusal.
 *
 * @param {string} reason
 * @returns {boolean} true only when the refusal provably precedes the reservation
 */
function classifyEvaluatorReason(reason) {
  if (typeof reason !== 'string' || reason.length < 1) return false;
  return RETRYABLE_EVALUATOR_REASONS.includes(reason);
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
  RETRYABLE_EVALUATOR_REASONS,
  classifyEvaluatorReason,
  classifyTransportRefusal,
});
