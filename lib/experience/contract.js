'use strict';

/**
 * Experience Core E1 — ExperienceContract (#2376).
 *
 * The first of the three Experience Core abstractions, and the only one that
 * is pure: the event shape, the identity fields, the lifecycle vocabulary,
 * and the pure functions that decide whether a proposed event is admissible
 * against a run's current state.
 *
 * Pure functions, no I/O, no storage import, no upward require. Structural
 * validation lives here; domain outcome and learning-eligibility judgement
 * use additional validators (#2389), which become their own file when they
 * happen rather than letting this one grow past 400 lines.
 *
 * ## Identity (locked in R2)
 *
 * - `runId` — the Experience.
 * - `attemptId` — a retry or repair attempt within it.
 * - `invocationId` — a repeat of the same step.
 * - `eventId` — one immutable event.
 *
 * Parent-child and repair relationships are expressed through causality
 * fields (`causedByEventId`, `parentRunId`), not by reusing an id at a
 * different level. A repair starts a new attempt and does NOT inherit the
 * old approval — that is a rule with a test, not a convention.
 *
 * ## Lifecycle
 *
 * `run_started → action_proposed → policy_decided → execution_started →
 * execution_finished`, then, only when it genuinely happened: `verification`,
 * `failure`, `repair_proposed`, `repair_executed`, `memory_update`, and
 * `run_closed`. Validated through `sequence` + `causedByEventId` rather than
 * one rigid order, because a failure can legitimately arrive from the
 * executor after `execution_finished` or from the verifier after
 * `verification`. The vocabulary is extensible; the causality is not.
 *
 * ## The three axes
 *
 * `executionStatus`, `outcomeStatus` and `learningEligibility` are separate
 * fields and no function in this module derives the second from the first.
 * `resolveLearningEligibility()` takes all three axes plus the acceptance
 * proofs as input and never infers a missing `outcomeStatus`. Extra
 * attributes on the input (including LLM provenance markers) are ignored —
 * LLM usage is a provenance attribute, never an automatic rejection or
 * acceptance.
 */

const EVENT_TYPES = Object.freeze({
  RUN_STARTED: 'run_started',
  ACTION_PROPOSED: 'action_proposed',
  POLICY_DECIDED: 'policy_decided',
  EXECUTION_STARTED: 'execution_started',
  EXECUTION_FINISHED: 'execution_finished',
  VERIFICATION: 'verification',
  FAILURE: 'failure',
  REPAIR_PROPOSED: 'repair_proposed',
  REPAIR_EXECUTED: 'repair_executed',
  MEMORY_UPDATE: 'memory_update',
  RUN_CLOSED: 'run_closed',
  // #2395 (design #2384): the deterministic router's admission/refusal
  // decision, recorded between policy_decided and execution_started when a
  // run's procedure choice went through the router. Extensible vocabulary,
  // per this file's own rule — no causality change needed.
  ROUTING_DECIDED: 'routing_decided',
});

const KNOWN_EVENT_TYPES = Object.freeze(new Set(Object.values(EVENT_TYPES)));

const TERMINAL_EVENT_TYPES = Object.freeze(new Set([EVENT_TYPES.RUN_CLOSED]));

const REPAIR_EVENT_TYPES = Object.freeze(
  new Set([EVENT_TYPES.REPAIR_PROPOSED, EVENT_TYPES.REPAIR_EXECUTED]),
);

const EXECUTION_STATUSES = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const OUTCOME_STATUSES = Object.freeze({
  VERIFIED: 'verified',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

const LEARNING_ELIGIBILITY = Object.freeze({
  POSITIVE_PROCEDURE: 'positive_procedure',
  NEGATIVE_EXAMPLE: 'negative_example',
  NEEDS_REVIEW: 'needs_review',
  INELIGIBLE: 'ineligible',
});

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isKnownEventType(type) {
  return typeof type === 'string' && KNOWN_EVENT_TYPES.has(type);
}

function isTerminalEventType(type) {
  return typeof type === 'string' && TERMINAL_EVENT_TYPES.has(type);
}

function isRepairEventType(type) {
  return typeof type === 'string' && REPAIR_EVENT_TYPES.has(type);
}

/**
 * Structural shape check only: required identity fields are present and
 * well-formed, optional causality fields are well-formed when present, and
 * `sequence` is a positive integer when the writer supplied one. The payload
 * itself is opaque to the contract.
 */
function validateEventShape(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, code: 'invalid_event' };
  }
  if (!isNonEmptyString(event.runId)) return { ok: false, code: 'invalid_run_id' };
  if (!isNonEmptyString(event.eventId)) return { ok: false, code: 'invalid_event_id' };
  if (!isKnownEventType(event.type)) return { ok: false, code: 'unknown_event_type' };
  if (event.workspaceId !== undefined && !isNonEmptyString(event.workspaceId)) {
    return { ok: false, code: 'invalid_workspace_id' };
  }
  for (const field of ['attemptId', 'invocationId', 'causedByEventId', 'parentRunId']) {
    if (event[field] !== undefined && event[field] !== null && !isNonEmptyString(event[field])) {
      return { ok: false, code: `invalid_${field}` };
    }
  }
  if (event.sequence !== undefined
    && (!Number.isInteger(event.sequence) || event.sequence < 1)) {
    return { ok: false, code: 'invalid_sequence' };
  }
  return { ok: true };
}

/**
 * Lifecycle vocabulary check against the run's prior event types (oldest
 * first). The first event must open the run; the vocabulary is otherwise
 * deliberately not a rigid order; a closed run accepts nothing further.
 */
function checkLifecycle(priorTypes, type) {
  const seen = Array.isArray(priorTypes) ? priorTypes : [];
  if (seen.some((t) => isTerminalEventType(t))) return { ok: false, code: 'terminal_run' };
  if (seen.length === 0) {
    return type === EVENT_TYPES.RUN_STARTED
      ? { ok: true }
      : { ok: false, code: 'run_must_start_first' };
  }
  if (type === EVENT_TYPES.RUN_STARTED) return { ok: false, code: 'duplicate_run_started' };
  return { ok: true };
}

/**
 * Causality check: a `causedByEventId` must resolve to an event already seen
 * in the same run. Cross-run references are refused here; recording the
 * parent link itself is the journal's read side (`parentOf`).
 */
function checkCausality(seenEventIds, event) {
  if (event.causedByEventId === undefined || event.causedByEventId === null) {
    return { ok: true };
  }
  const seen = seenEventIds && typeof seenEventIds.has === 'function'
    ? seenEventIds
    : new Set();
  return seen.has(event.causedByEventId)
    ? { ok: true }
    : { ok: false, code: 'unknown_causality_ref' };
}

/**
 * Repair admissibility (E1 rule with a test, not a convention): a repair
 * starts a new attempt and does NOT inherit the old approval.
 *
 * `context` carries what the run already knows: `{ priorAttemptId,
 * priorApprovalId }`. A repair event must name an `attemptId` distinct from
 * the failed attempt, and must not carry the prior approval id forward.
 */
function checkRepair(event, context = {}) {
  if (!isRepairEventType(event.type)) return { ok: true };
  if (!isNonEmptyString(event.attemptId) || event.attemptId === context.priorAttemptId) {
    return { ok: false, code: 'repair_requires_new_attempt' };
  }
  if (context.priorApprovalId !== undefined && context.priorApprovalId !== null
    && event.approvalId === context.priorApprovalId) {
    return { ok: false, code: 'repair_inherits_approval' };
  }
  return { ok: true };
}

/**
 * Decide whether a proposed event is admissible against the run's current
 * state. `ledgerView` is `{ types: [...], seenIds: Set|Array, closed:
 * boolean }`; it is read, never mutated. The journal owns the authoritative
 * ledger — this function only judges.
 */
function admitEvent(ledgerView, event, repairContext = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, code: 'invalid_event' };
  }
  // Closed is closed: a terminal run refuses before any other check, so a
  // writer holding a stale handle learns the run is over rather than getting
  // a shape diagnostic for a payload that would be refused anyway.
  const view = ledgerView && typeof ledgerView === 'object' ? ledgerView : {};
  const types = Array.isArray(view.types) ? view.types : [];
  const closed = view.closed === true || types.some((t) => isTerminalEventType(t));
  if (closed) return { ok: false, code: 'terminal_run' };
  const shape = validateEventShape(event);
  if (!shape.ok) return shape;
  const lifecycle = checkLifecycle(types, event.type);
  if (!lifecycle.ok) return lifecycle;
  const seen = view.seenIds instanceof Set
    ? view.seenIds
    : new Set(Array.isArray(view.seenIds) ? view.seenIds : []);
  const causality = checkCausality(seen, event);
  if (!causality.ok) return causality;
  return checkRepair(event, repairContext);
}

function allProofsPresent(proofs) {
  return Boolean(proofs)
    && proofs.integrity === true
    && proofs.coverage === true
    && proofs.verification === true
    && proofs.provenance === true
    && proofs.permission === true;
}

/**
 * Map the three axes plus the acceptance proofs onto a learning-eligibility
 * verdict. `outcomeStatus` is taken as given — a missing or `unknown`
 * outcome never becomes `verified` here, no matter how complete the
 * execution looks. That separation is the point of rule 10.
 */
function resolveLearningEligibility(input = {}) {
  const { executionStatus, outcomeStatus, proofs } = input;
  if (input.verificationConflicting === true) {
    return { ok: true, eligibility: LEARNING_ELIGIBILITY.NEEDS_REVIEW };
  }
  if (executionStatus === EXECUTION_STATUSES.COMPLETED
    && outcomeStatus === OUTCOME_STATUSES.VERIFIED
    && allProofsPresent(proofs)) {
    return { ok: true, eligibility: LEARNING_ELIGIBILITY.POSITIVE_PROCEDURE };
  }
  if (executionStatus === EXECUTION_STATUSES.FAILED
    && outcomeStatus === OUTCOME_STATUSES.FAILED
    && Boolean(proofs) && proofs.failureEvidence === true
    && proofs.permission === true) {
    return { ok: true, eligibility: LEARNING_ELIGIBILITY.NEGATIVE_EXAMPLE };
  }
  return { ok: true, eligibility: LEARNING_ELIGIBILITY.INELIGIBLE };
}

module.exports = {
  EVENT_TYPES,
  EXECUTION_STATUSES,
  OUTCOME_STATUSES,
  LEARNING_ELIGIBILITY,
  isKnownEventType,
  isTerminalEventType,
  isRepairEventType,
  validateEventShape,
  checkLifecycle,
  checkCausality,
  checkRepair,
  admitEvent,
  resolveLearningEligibility,
};
