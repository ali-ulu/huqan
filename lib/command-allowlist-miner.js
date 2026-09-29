'use strict';

/**
 * Derive a command allowlist from what people actually approved (#3025).
 *
 * Two inputs, joined on the admission id: the receipt trail, which holds the
 * human verdict but deliberately never the command, and the local command
 * shape log (lib/command-shape-log.js), which names the command of each
 * reviewed admission and nothing else.
 *
 * The residency miner (lib/residency-rule-miner.js) learns in one direction
 * only: it narrows where data may go. Nothing let the gate learn the other
 * direction -- to stop asking a person about a command that person keeps
 * approving. The benign-false-block-rate check records what that costs: every
 * ordinary inner-loop command (`npm test`, `npm run build`) stops on a prompt.
 *
 *   admission (shell command, decision `review`)
 *      -> outcome status `executed`  =  a human approved running it
 *      -> outcome status `blocked`   =  a human refused
 *
 * ## Proposal, never application
 *
 * Nothing here writes a policy file. The output is a candidate
 * `allowedCommands` list a person reads and decides on, for the same reason
 * the residency miner gives: a rule the engine installs on itself is a rule no
 * receipt can attest to.
 *
 * ## Only a person's decision counts
 *
 * Only an admission the gate sent to review carries a human judgement. One it
 * allowed on its own, or refused on its own, is not evidence either way: a
 * gate block is often about something other than the command (a missing
 * identity card blocks `npm test` too), and letting it count would let one
 * misconfigured agent disqualify a command for good. A proposal cannot weaken
 * a gate block anyway -- `allowlistMatch` never overrides the denylist.
 *
 * ## One refusal disqualifies; silence is not evidence
 *
 * As in the residency miner: not a majority vote, and a review nobody resolved
 * lands in `unresolved`, never in the proposal.
 *
 * ## Never broader than an entry can safely be
 *
 * `allowlistMatch` treats an entry as a leading argument run, so a one-word
 * entry (`node`) would promote every invocation of that program, `node -e`
 * included. One-word shapes are reported, never proposed. A shape whose
 * category the allowlist cannot promote (a write, a deploy) is reported too:
 * proposing it would read as a fix while changing nothing.
 */

const { ACTION_CATEGORIES } = require('./action-risk-classifier');
const { isPlainObject } = require('./is-plain-object');

const DEFAULT_MIN_OBSERVATIONS = 3;

const MINER_VERSION = 'huqan.command-allowlist-miner.v1';

const OUTCOME_RECEIPT_KIND = 'external_action_outcome_receipt';

const MIN_SHAPE_WORDS = 2;

/**
 * The logged shape of each admission, by admission id. A line that is not
 * well-formed is dropped, and so is an id logged twice with different shapes:
 * the log is not hash-covered, and a disagreement about which command ran is
 * not something to pick a winner in.
 */
function shapesByAdmission(entries) {
  const shapes = new Map();
  const conflicted = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isPlainObject(entry) || typeof entry.admissionId !== 'string' || !entry.admissionId) continue;
    if (typeof entry.shape !== 'string' || !entry.shape) continue;
    const observation = {
      workspaceId: String(entry.workspaceId || ''),
      shape: entry.shape,
      riskCategory: String(entry.riskCategory || ''),
    };
    const seen = shapes.get(entry.admissionId);
    if (seen && (seen.shape !== observation.shape || seen.workspaceId !== observation.workspaceId)) {
      conflicted.add(entry.admissionId);
    }
    shapes.set(entry.admissionId, observation);
  }
  for (const admissionId of conflicted) shapes.delete(admissionId);
  return shapes;
}

/** The logged shape for this admission, or null when none can be trusted. */
function commandObservationOf(receipt, shapes) {
  const observation = shapes.get(receipt.admissionId);
  if (!observation) return null;
  // The receipt is the authority on the workspace; a log line that places the
  // admission somewhere else is describing a different action.
  if (observation.workspaceId !== String(receipt.workspaceId || '')) return null;
  return observation;
}

function outcomeStatuses(list) {
  const outcomes = new Map();
  for (const receipt of list) {
    if (receipt.receiptKind !== OUTCOME_RECEIPT_KIND) continue;
    if (typeof receipt.admissionId === 'string' && receipt.admissionId) {
      outcomes.set(receipt.admissionId, receipt.status);
    }
  }
  return outcomes;
}

/** approved / refused / unresolved, or null when no person was asked. */
function verdictFor(receipt, outcomes) {
  if (receipt.decision !== 'review') return null;
  const outcome = outcomes.get(receipt.admissionId);
  if (outcome === 'executed') return 'approved';
  if (outcome === 'blocked') return 'refused';
  return 'unresolved';
}

function whyNotProposed(entry, minObservations) {
  if (entry.refused > 0) return 'refused at least once';
  if (entry.approved < minObservations) return `only ${entry.approved} approval(s); ${minObservations} required`;
  if (entry.shape.split(' ').length < MIN_SHAPE_WORDS) {
    return 'a one-word entry would allow every invocation of this program';
  }
  if (entry.riskCategories.some((category) => category !== ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION)) {
    return `category ${entry.riskCategories.join(', ')} cannot be promoted by allowedCommands`;
  }
  return '';
}

function tallyObservations(list, outcomes, shapes) {
  const tally = new Map();
  for (const receipt of list) {
    if (receipt.receiptKind === OUTCOME_RECEIPT_KIND) continue;
    const observation = commandObservationOf(receipt, shapes);
    if (!observation) continue;
    const verdict = verdictFor(receipt, outcomes);
    if (!verdict) continue;
    const workspaceId = typeof receipt.workspaceId === 'string' && receipt.workspaceId ? receipt.workspaceId : 'default';
    const key = `${workspaceId}\u0000${observation.shape}`;
    if (!tally.has(key)) {
      tally.set(key, { workspaceId, shape: observation.shape, riskCategories: [], approved: 0, refused: 0, unresolved: 0 });
    }
    const entry = tally.get(key);
    entry[verdict] += 1;
    if (!entry.riskCategories.includes(observation.riskCategory)) entry.riskCategories.push(observation.riskCategory);
  }
  return [...tally.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.shape.localeCompare(b.shape));
}

/**
 * @param {object[]} receipts admission and outcome receipts, in any order
 * @param {object} [options]
 * @param {object[]} [options.shapes] lines of the command shape log
 * @param {number} [options.minObservations] approvals needed before proposing
 * @returns {{proposals: {workspaceId: string, allowedCommands: string[]}[], evidence: object[], unresolved: object[], minObservations: number, minerVersion: string}}
 */
function mineCommandAllowlist(receipts, options = {}) {
  const minObservations = Number.isInteger(options.minObservations) && options.minObservations > 0
    ? options.minObservations
    : DEFAULT_MIN_OBSERVATIONS;
  const list = Array.isArray(receipts) ? receipts.filter(isPlainObject) : [];
  const evidence = tallyObservations(list, outcomeStatuses(list), shapesByAdmission(options.shapes));

  const byWorkspace = new Map();
  const unresolved = [];
  for (const entry of evidence) {
    const why = whyNotProposed(entry, minObservations);
    if (why) {
      unresolved.push({ ...entry, why });
      continue;
    }
    if (!byWorkspace.has(entry.workspaceId)) byWorkspace.set(entry.workspaceId, []);
    byWorkspace.get(entry.workspaceId).push(entry.shape);
  }

  return {
    proposals: [...byWorkspace].map(([workspaceId, allowedCommands]) => ({ workspaceId, allowedCommands })),
    evidence,
    unresolved,
    minObservations,
    minerVersion: MINER_VERSION,
  };
}

module.exports = {
  DEFAULT_MIN_OBSERVATIONS,
  MINER_VERSION,
  mineCommandAllowlist,
};
