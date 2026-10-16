'use strict';

// #2505 A, enforcement wiring (first production path): the external action
// guard holds session impact against the durable budget ledger.
//
// Dormant unless the deployment opts in with `options.impactBudget = {
// graph, policy: { policyVersion, reviewAt, quorumAt, blockAt } }`: without
// both, every action evaluates exactly as before. When armed, this runs
// after every other gate, so it only ever tightens: the strictest verdict
// wins via the guard's own merge.
//
// Semantics, per the control-set design:
// - The decision uses the projected total including the proposed action.
// - Scores commit to the budget only on allow. Denied attempts never
//   consume budget; they feed the bypass signals instead.
// - A missing score, scope, graph, or a ledger failure holds for review;
//   a high-risk or irreversible action blocks instead.
// - `quorum` has no guard state here: it is held as review with a quorum
//   reason, never executed, never silently allowed.
// - Run scoping is session-only: the envelope carries no run identity, so a
//   run budget cannot be derived here. That half stays open.

const { externalActionBlastRadius } = require('./blast-radius');
const {
  readBudgetState,
  reserveImpact,
  commitReservation,
  projectBudgetVerdict,
} = require('./impact-budget-ledger');
const { buildExternalActionBinding } = require('./external-action-action-binding');
const {
  EXTERNAL_ACTION_DECISIONS,
  EXTERNAL_ACTION_REASONS,
} = require('./external-action-guard-rules');
const { RISK_LEVELS } = require('./action-risk-classifier');

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function validPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  try {
    const policyVersion = text(policy.policyVersion);
    const reviewAt = policy.reviewAt;
    const quorumAt = policy.quorumAt;
    const blockAt = policy.blockAt;
    for (const value of [reviewAt, quorumAt, blockAt]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    }
    if (!(reviewAt <= quorumAt && quorumAt <= blockAt)) return null;
    return Object.freeze({ policyVersion, reviewAt, quorumAt, blockAt });
  } catch (_) {
    return null;
  }
}

function degradedFinding(reason, detail) {
  return Object.freeze({
    gate: 'impact-budget',
    decision: EXTERNAL_ACTION_DECISIONS.REVIEW,
    reason,
    enforced: true,
    detail: detail || null,
  });
}

/**
 * @param {object} args { envelope, decision, riskLevel, options }
 * @returns {{finding, committed: boolean}|null} null when disarmed
 */
function evaluateImpactBudget({ envelope, decision, riskLevel, options = {} } = {}) {
  const configured = options && typeof options === 'object' ? options.impactBudget : null;
  const graph = configured && typeof configured === 'object' ? configured.graph : null;
  const bands = validPolicy(configured && typeof configured === 'object' ? configured.policy : null);
  if (!graph || !bands) return null;
  if (typeof graph.runMutationOnce !== 'function'
    || typeof graph.getCommittedMutationResultsByPrefix !== 'function') {
    return { finding: degradedFinding(EXTERNAL_ACTION_REASONS.IMPACT_BUDGET_DEGRADED, 'impact graph unavailable'), committed: false };
  }

  const workspaceId = text(envelope.workspaceId);
  const sessionId = text(envelope.session && envelope.session.id);
  let blast = null;
  try {
    blast = externalActionBlastRadius(envelope);
  } catch (_) {
    blast = null;
  }
  const score = blast && Number.isFinite(blast.score) ? blast.score : null;
  const highRisk = riskLevel === RISK_LEVELS.CRITICAL
    || (blast && blast.dimensions && blast.dimensions.reversibility
      && blast.dimensions.reversibility.value === 'irreversible');
  if (!workspaceId || !sessionId || score === null) {
    if (highRisk) {
      return {
        finding: Object.freeze({
          gate: 'impact-budget',
          decision: EXTERNAL_ACTION_DECISIONS.BLOCK,
          reason: EXTERNAL_ACTION_REASONS.IMPACT_BUDGET_BLOCK,
          enforced: true,
          detail: 'unmeasurable high-risk action fails closed',
        }),
        committed: false,
      };
    }
    return { finding: degradedFinding(EXTERNAL_ACTION_REASONS.IMPACT_BUDGET_DEGRADED, 'missing score or scope'), committed: false };
  }

  let state;
  try {
    state = readBudgetState(graph, { policyVersion: bands.policyVersion, workspaceId, sessionId });
  } catch (_) {
    return {
      finding: degradedFinding(EXTERNAL_ACTION_REASONS.IMPACT_BUDGET_DEGRADED, 'budget ledger unreadable'),
      committed: false,
    };
  }
  const projection = projectBudgetVerdict(state, score, bands);
  const map = {
    allow: EXTERNAL_ACTION_DECISIONS.ALLOW,
    review: EXTERNAL_ACTION_DECISIONS.REVIEW,
    quorum: EXTERNAL_ACTION_DECISIONS.REVIEW,
    block: EXTERNAL_ACTION_DECISIONS.BLOCK,
  };
  const reasonMap = {
    allow: EXTERNAL_ACTION_REASONS.ALLOWED,
    review: EXTERNAL_ACTION_REASONS.IMPACT_BUDGET_REVIEW,
    quorum: EXTERNAL_ACTION_REASONS.IMPACT_BUDGET_QUORUM,
    block: EXTERNAL_ACTION_REASONS.IMPACT_BUDGET_BLOCK,
  };
  const gateDecision = map[projection.verdict];
  const finding = Object.freeze({
    gate: 'impact-budget',
    decision: gateDecision,
    reason: reasonMap[projection.verdict],
    enforced: true,
    projected: projection.projected,
    bands: projection.bands,
  });

  // Commit on allow only, after the merge below keeps it allowed: denied
  // attempts never consume budget. The binding digest is the idempotency
  // key, so a retried action replays instead of double-charging.
  let committed = false;
  if (decision === EXTERNAL_ACTION_DECISIONS.ALLOW && gateDecision === EXTERNAL_ACTION_DECISIONS.ALLOW) {
    try {
      const binding = buildExternalActionBinding(envelope);
      const key = binding && binding.digest ? `action:${binding.digest}` : null;
      if (key) {
        const outcome = reserveImpact(graph, {
          scope: { policyVersion: bands.policyVersion, workspaceId, sessionId },
          amount: score,
          idempotencyKey: key,
        });
        commitReservation(graph, { reservationId: outcome.reservationId, idempotencyKey: `commit:${key}` });
        committed = !outcome.replayed;
      }
    } catch (_) {
      // A commit failure must not flip an allowed action on its own; the
      // finding already records the projection, and the next action re-reads.
      committed = false;
    }
  }
  return { finding, committed };
}

module.exports = {
  evaluateImpactBudget,
};
