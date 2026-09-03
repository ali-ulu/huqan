'use strict';

/**
 * Derive a data-residency rule from what people actually approved.
 *
 * This is the half that makes AB12 a learned boundary rather than a hand-written
 * one. AB9 observes that a payload carried citizen data; the guard records where
 * it was headed; a human then approves or refuses each one. That trail is a
 * labelled corpus, and the label was produced by the person accountable for the
 * decision rather than by a heuristic.
 *
 *   admission (PII + destination D, review required)
 *      -> outcome status `executed`  =  a human approved sending citizen data to D
 *      -> outcome status `blocked`   =  a human refused
 *
 * Given enough of those, "which destinations are inside our residency" stops
 * being a question somebody answers from memory in a config file.
 *
 * ## Proposal, never application
 *
 * Nothing here writes a policy file. The output is a candidate a person reads
 * and decides on, which is the same shape lib/hypothesis-tuning.js uses for
 * thresholds and for the same reason: a rule the engine installs on itself is a
 * rule no receipt can attest to. A receipt says "policy X decided"; that is
 * worth what the stability of X is worth, and X drifting on its own makes the
 * record mean less than it says.
 *
 * ## One refusal disqualifies
 *
 * A destination is proposed only when every human who looked at it approved it.
 * This is deliberately not a majority vote: a residency boundary is a legal
 * commitment, and "nine people said yes and one said no" is a description of a
 * disagreement, not of consent. The disagreement is reported so somebody
 * resolves it, rather than averaged away.
 *
 * ## Silence is not evidence
 *
 * A destination seen once, or seen only on actions nobody ever resolved, lands
 * in `unresolved` rather than in the proposal. Inferring a boundary from a
 * single observation is how a learned rule becomes wrong in exactly the
 * direction nobody checks.
 */

const DEFAULT_MIN_OBSERVATIONS = 3;

const MINER_VERSION = 'huqan.residency-rule-miner.v1';

const OUTCOME_RECEIPT_KIND = 'external_action_outcome_receipt';

const { isPlainObject } = require('./is-plain-object');

function findingsOf(receipt) {
  const findings = receipt && receipt.metadata && receipt.metadata.findings;
  return Array.isArray(findings) ? findings : [];
}

/** The destinations and PII types the guard observed for this admission. */
function observationOf(receipt) {
  const egress = findingsOf(receipt).find((f) => f && f.gate === 'AB9');
  if (!egress) return null;
  const destinations = Array.isArray(egress.destinations) ? egress.destinations.filter(Boolean) : [];
  const piiTypes = Array.isArray(egress.piiTypes) ? egress.piiTypes.filter(Boolean) : [];
  if (destinations.length === 0 || piiTypes.length === 0) return null;
  return { destinations, piiTypes };
}

/**
 * The human's verdict for an admission, or null when nobody resolved it.
 *
 * Read from the outcome receipt rather than the admission: the admission only
 * records that review was required, and an unresolved review is not a decision.
 * Treating "pending forever" as approval would learn a boundary from inaction.
 */
function verdictFor(admissionId, outcomes) {
  const outcome = outcomes.get(admissionId);
  if (!outcome) return null;
  if (outcome === 'executed') return 'approved';
  if (outcome === 'blocked') return 'refused';
  return null;
}

/**
 * @param {object[]} receipts admission and outcome receipts, in any order
 * @param {object} [options]
 * @param {number} [options.minObservations] approvals needed before proposing
 * @returns {{proposal: {allowedDestinations: string[]}|null, evidence: object[], unresolved: object[], minerVersion: string}}
 */
function mineResidencyRule(receipts, options = {}) {
  const minObservations = Number.isInteger(options.minObservations) && options.minObservations > 0
    ? options.minObservations
    : DEFAULT_MIN_OBSERVATIONS;

  const list = Array.isArray(receipts) ? receipts.filter(isPlainObject) : [];

  const outcomes = new Map();
  for (const receipt of list) {
    if (receipt.receiptKind !== OUTCOME_RECEIPT_KIND) continue;
    const admissionId = receipt.admissionId;
    if (typeof admissionId === 'string' && admissionId) outcomes.set(admissionId, receipt.status);
  }

  const tally = new Map();
  const record = (destination, key) => {
    if (!tally.has(destination)) tally.set(destination, { destination, approved: 0, refused: 0, unresolved: 0 });
    tally.get(destination)[key] += 1;
  };

  for (const receipt of list) {
    // Matched by "not an outcome" rather than by an admission kind name: the
    // admission side has three names that depend on the verdict
    // (admission / review / rejection receipt), and an action that needed
    // review is exactly the one carrying a human decision worth learning from.
    // Enumerating the three would silently drop a fourth if one is ever added.
    if (receipt.receiptKind === OUTCOME_RECEIPT_KIND) continue;
    const observation = observationOf(receipt);
    if (!observation) continue;
    const verdict = verdictFor(receipt.admissionId, outcomes);
    for (const destination of observation.destinations) {
      record(destination, verdict === 'approved' ? 'approved' : verdict === 'refused' ? 'refused' : 'unresolved');
    }
  }

  const evidence = [...tally.values()].sort((a, b) => a.destination.localeCompare(b.destination));
  const allowedDestinations = [];
  const unresolved = [];

  for (const entry of evidence) {
    if (entry.refused > 0) {
      // Not a majority vote: a refusal is a person saying this transfer should
      // not happen, and averaging that against approvals would propose a rule
      // nobody agreed to.
      unresolved.push({ ...entry, why: 'a human refused this destination at least once' });
      continue;
    }
    if (entry.approved < minObservations) {
      unresolved.push({ ...entry, why: `only ${entry.approved} approval(s); ${minObservations} required` });
      continue;
    }
    allowedDestinations.push(entry.destination);
  }

  return {
    proposal: allowedDestinations.length > 0 ? { allowedDestinations } : null,
    evidence,
    unresolved,
    minObservations,
    minerVersion: MINER_VERSION,
  };
}

module.exports = {
  DEFAULT_MIN_OBSERVATIONS,
  OUTCOME_RECEIPT_KIND,
  MINER_VERSION,
  observationOf,
  mineResidencyRule,
};
