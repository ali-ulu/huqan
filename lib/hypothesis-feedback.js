'use strict';

/**
 * Per-rule feedback on hypothesis candidates.
 *
 * The engine proposes and a person decides; this module reads what those
 * decisions add up to, rule by rule. It is the first half of the learning
 * loop: without it the system has no way to tell a rule that earns its
 * findings from one that mostly produces noise.
 *
 * ## Read-only, with no exceptions
 *
 * Nothing here writes a node, an edge, a candidate or an audit event, and
 * nothing changes a threshold. It reports; acting on the report is a separate
 * decision made elsewhere.
 *
 * ## The status values it counts are a contract
 *
 * `accepted` / `rejected` are written by lib/hypothesis-review.js and read
 * here. They are the one signal that crosses between the two surfaces.
 */

const { HYPOTHESIS_SOURCE_TYPE, ruleTypeFromClaim } = require('./hypothesis-review');

/**
 * A hypothesis candidate whose claim lost its `[TYPE]` tag is still a
 * reviewed candidate. Bucketing it keeps it visible in the report rather than
 * quietly shrinking the totals it belongs to.
 */
const UNKNOWN_RULE_TYPE = 'BİLİNMEYEN';

function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function isHypothesisCandidate(candidate) {
  return candidate?.provenance?.sourceType === HYPOTHESIS_SOURCE_TYPE;
}

function emptyTally() {
  return { accepted: 0, rejected: 0, pending: 0 };
}

/**
 * Rates are over *reviewed* candidates, not over the total. A pending
 * candidate carries no verdict, so counting it in the denominator would read
 * as evidence against a rule that has simply not been judged yet -- exactly
 * the reading a tuning step must not make.
 */
function summarize(tally) {
  const reviewed = tally.accepted + tally.rejected;
  return {
    ...tally,
    reviewed,
    total: reviewed + tally.pending,
    acceptanceRate: reviewed > 0 ? tally.accepted / reviewed : null,
    rejectionRate: reviewed > 0 ? tally.rejected / reviewed : null,
  };
}

/**
 * @param {object} kernel
 * @param {{workspaceId?: string}} [options]
 * @returns {{meta: object, rules: object[], totals: object}} deterministic; rules sorted by rule type.
 */
function buildFeedbackStats(kernel, options = {}) {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  const candidates = (kernel?.getCandidateClaims?.({ workspaceId }) || [])
    .filter(isHypothesisCandidate);

  const byRule = new Map();
  const totals = emptyTally();

  for (const candidate of candidates) {
    const ruleType = ruleTypeFromClaim(candidate.claim) || UNKNOWN_RULE_TYPE;
    if (!byRule.has(ruleType)) byRule.set(ruleType, emptyTally());
    const tally = byRule.get(ruleType);
    // Any status that is not a verdict counts as pending: the loop cares
    // whether a decision was made, not how a candidate came to be waiting.
    const bucket = candidate.status === 'accepted' || candidate.status === 'rejected'
      ? candidate.status
      : 'pending';
    tally[bucket] += 1;
    totals[bucket] += 1;
  }

  const rules = [...byRule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ruleType, tally]) => ({ ruleType, ...summarize(tally) }));

  return {
    meta: {
      workspaceId,
      candidateCount: candidates.length,
      ruleCount: rules.length,
    },
    rules,
    totals: summarize(totals),
  };
}

module.exports = {
  UNKNOWN_RULE_TYPE,
  buildFeedbackStats,
  isHypothesisCandidate,
};
