'use strict';

// Single owner of how the gate outcome trail is read as human decisions.
// lib/command-allowlist-miner.js, lib/residency-rule-miner.js and
// lib/gate-outcome-projection.js all read the same append-only trail; if they
// disagreed about what an outcome means, a boundary one of them refused could
// be learned as approved by another. Grouping (by command shape, destination
// or claim) stays with each consumer.

const { isPlainObject } = require('./is-plain-object');

const OUTCOME_RECEIPT_KIND = 'external_action_outcome_receipt';

/**
 * executed -> approved, blocked -> refused, anything else -> null. An
 * unresolved review is not a decision; treating "pending forever" as approval
 * would learn a boundary from inaction.
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
  OUTCOME_RECEIPT_KIND,
  verdictForOutcomeStatus,
  outcomeStatusByAdmission,
};
