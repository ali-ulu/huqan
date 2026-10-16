'use strict';

/**
 * Typed handoff termination reasons (R23, #3478).
 *
 * This module is the consumer of the route receipt `handoff_reason`: it closes
 * a human/target handoff with a separate, explicit termination reason instead
 * of reusing the delegation cause. The wire keeps carrying only the legacy
 * `delegated_task` reason, so no route-receipt schema migration is owed here;
 * the termination is a durable sidecar record owned by
 * `lib/a2a/handoff-cursor.js`, never a new wire field.
 *
 * Fail-closed: the only recognized wire reason is the legacy one every
 * existing receipt already carries, and the only recognized closers are the
 * human and the target named by the issue. Anything else throws before any
 * record is written, so an unknown handoff can never be closed silently.
 */

const TERMINATION_SCHEMA_VERSION = 'v5-a2a-handoff-termination-v1';
const LEGACY_HANDOFF_REASON = 'delegated_task';

// Separate termination reasons for the two closers the issue names. A human
// takeover and a target completion close different things, so they must not
// share one reason string.
const HANDOFF_TERMINATION_REASONS = Object.freeze({
  HUMAN_HANDOFF: 'human_handoff',
  TARGET_COMPLETE: 'target_complete',
});

const CLOSED_BY = Object.freeze({ HUMAN: 'human', TARGET: 'target' });

function isTerminationReason(value) {
  return value === HANDOFF_TERMINATION_REASONS.HUMAN_HANDOFF
    || value === HANDOFF_TERMINATION_REASONS.TARGET_COMPLETE;
}

/**
 * Resolve the termination reason that closes a handoff.
 *
 * `request` is `{ handoffReason, closedBy }`. Returns a frozen
 * `{ handoffReason, closedBy, terminationReason }`. Throws on anything the
 * allowlist does not recognize: an unknown wire reason or an unknown closer
 * refuses the close instead of guessing one.
 */
function resolveHandoffTermination(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('handoff termination request must be an object');
  }
  const { handoffReason, closedBy } = request;
  if (handoffReason !== LEGACY_HANDOFF_REASON) {
    throw new Error('handoff_reason_unknown');
  }
  if (closedBy !== CLOSED_BY.HUMAN && closedBy !== CLOSED_BY.TARGET) {
    throw new Error('handoff_closer_unknown');
  }
  const terminationReason = closedBy === CLOSED_BY.HUMAN
    ? HANDOFF_TERMINATION_REASONS.HUMAN_HANDOFF
    : HANDOFF_TERMINATION_REASONS.TARGET_COMPLETE;
  return Object.freeze({ handoffReason, closedBy, terminationReason });
}

module.exports = Object.freeze({
  TERMINATION_SCHEMA_VERSION,
  LEGACY_HANDOFF_REASON,
  HANDOFF_TERMINATION_REASONS,
  CLOSED_BY,
  isTerminationReason,
  resolveHandoffTermination,
});
