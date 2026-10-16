'use strict';

// Single owner of how the gate outcome trail is read as human decisions.
// lib/command-allowlist-miner.js, lib/residency-rule-miner.js and
// lib/gate-outcome-projection.js all read the same append-only trail; if they
// disagreed about what an outcome means, a boundary one of them refused could
// be learned as approved by another. Grouping (by command shape, destination
// or claim) stays with each consumer.

const { isPlainObject } = require('./is-plain-object');

const OUTCOME_RECEIPT_KIND = 'external_action_outcome_receipt';

// #3500 (R45): the outcome status a gate fault (a thrown or malformed gate,
// failed closed) is recorded under. It is deliberately not `blocked`: a
// `blocked` outcome is a person or a rule refusing the action, while
// `captured` is the guard itself failing to reach a decision. Keeping them one
// value would let the guard's own noise teach the miners that a command or a
// destination was refused, which is a rule no person ever agreed to.
const CAPTURED_OUTCOME_STATUS = 'captured';

/**
 * Whether an outcome status names a fail-closed gate fault rather than a
 * decision. A captured outcome is evidence the gate ran and could not decide;
 * it is never evidence about the action.
 */
function isCapturedOutcomeStatus(status) {
  return status === CAPTURED_OUTCOME_STATUS;
}

// #3617 (R52): the outcome status an execution is filed under when the guard
// reached an allow while one of its gates was holding a degraded input -- it
// could not measure what it was asked to measure and let the action through
// anyway. The action really did run, so it is not `blocked`; but the guard was
// not whole when it said yes, so it is not a clean `executed` either. Filing it
// as plain `executed` would hand the outcome miners a full approval learned
// from a decision the guard could only half-make.
const DEGRADED_OUTCOME_STATUS = 'executed_but_degraded';

/**
 * Whether an outcome status names a degraded execution rather than a clean one.
 */
function isDegradedOutcomeStatus(status) {
  return status === DEGRADED_OUTCOME_STATUS;
}

/**
 * Whether an admission receipt's own findings record a degraded gate hold
 * (#3617 R52). Read from the admission receipt, which is the authority, so a
 * caller cannot re-label a clean allow as degraded by saying so in the outcome.
 *
 * A degraded hold is what the guard writes when a gate could not measure its
 * input and held the action for review instead of guessing (see
 * lib/impact-budget-gate.js): `enforced: true` plus a human-readable `detail`,
 * on a `review` finding. A `block` finding that also carries a detail is a
 * refusal, not a hold, and does not count.
 */
function admissionReceiptHasDegradedGate(admissionReceipt) {
  const findings = admissionReceipt && admissionReceipt.metadata && admissionReceipt.metadata.findings;
  if (!Array.isArray(findings)) return false;
  return findings.some((finding) => finding
    && finding.enforced === true
    && finding.decision === 'review'
    && typeof finding.detail === 'string'
    && finding.detail.length > 0);
}

/**
 * executed -> approved, blocked -> refused, anything else -> null. An
 * unresolved review is not a decision; treating "pending forever" as approval
 * would learn a boundary from inaction. A `captured` outcome is a gate fault,
 * not a refusal, so it carries no verdict either -- `isCapturedOutcomeStatus`
 * names it for a reader that must show it rather than learn from it. A degraded
 * execution (`executed_but_degraded`, #3617) is the same kind of non-decision:
 * the action ran, but the guard was not whole when it allowed it, so it must
 * not be learned as a clean approval -- `isDegradedOutcomeStatus` names it.
 */
function verdictForOutcomeStatus(status) {
  if (status === 'executed') return 'approved';
  if (status === 'blocked') return 'refused';
  return null;
}

/**
 * Reduce outcome receipts to one status per admission id.
 *
 * @param {object[]} receipts admission and outcome receipts, in any order
 * @returns {Map<string, string>} admissionId -> outcome status
 */
function outcomeStatusByAdmission(receipts) {
  const statuses = new Map();
  if (!Array.isArray(receipts)) return statuses;
  for (const receipt of receipts) {
    if (!isPlainObject(receipt) || receipt.receiptKind !== OUTCOME_RECEIPT_KIND) continue;
    const admissionId = receipt.admissionId;
    if (typeof admissionId !== 'string' || !admissionId) continue;
    // Outcomes are appended, so an admission can carry more than one. A
    // refusal sticks: a later `executed` must not erase the person who said
    // no, whichever order the lines arrive in.
    if (statuses.get(admissionId) === 'blocked') continue;
    statuses.set(admissionId, receipt.status);
  }
  return statuses;
}

module.exports = {
  CAPTURED_OUTCOME_STATUS,
  DEGRADED_OUTCOME_STATUS,
  OUTCOME_RECEIPT_KIND,
  admissionReceiptHasDegradedGate,
  isCapturedOutcomeStatus,
  isDegradedOutcomeStatus,
  verdictForOutcomeStatus,
  outcomeStatusByAdmission,
};
