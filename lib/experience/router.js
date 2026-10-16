'use strict';

/**
 * Experience — Deterministic Router (#2395, design #2384).
 *
 * Given a request's declared shape and a list of candidate capabilities
 * (each carrying its own capability-trust rung from ./capability-trust.js),
 * decide which capability's bound procedure executes — or refuse. Pure: no
 * I/O, no storage, no model call, no trust-registry import. The caller reads
 * capability trust and hands this module a snapshot; this module only
 * matches, ranks and records the decision as data.
 *
 * ## Matching — structural, not scored
 *
 * A request matches a capability when the capability's declared
 * preconditions are satisfied exactly by the request's declared fields:
 * every precondition key must be present on the request with the same
 * value. No fuzzy comparison, no embeddings, no model call — the same input
 * always produces the same match set.
 *
 * ## Specificity (open design question, resolved pragmatically)
 *
 * #2384's design comment says the more specific of two matching
 * capabilities wins, "same principle as CSS specificity," and offers
 * "subset relation cardinality" as an acceptable implementation without
 * fully disambiguating direction. This module resolves it the way CSS
 * specificity and dispatch-by-narrowest-rule normally read: a capability
 * that declares MORE precondition fields (a narrower, more constrained
 * match) is more specific and wins over one that declares fewer fields but
 * still matches. `specificityRank` in `candidatesConsidered` is exactly the
 * precondition-field count, descending. This is flagged as a resolved
 * ambiguity, not a silent guess — see the implementation report.
 *
 * A separate scoring function is deliberately NOT implemented: per the
 * design, it is an optional secondary tool only for ranking among
 * already-structurally-matching candidates, and specificity plus the trust
 * rung plus lexicographic order already produce a single, deterministic
 * winner every time (acceptance test 4). `matchScoreVersion` is recorded as
 * `SCORE_NOT_USED_VERSION` so a future score function's absence, and any
 * later introduction, are both visible as a version change in
 * `routing_decided` history.
 *
 * ## No match / no eligible match
 *
 * Refusal is the default and is always recorded, never silently patched
 * over with a fallback: `no_structural_match` (nothing matched) or
 * `no_eligible_match` (something matched but every match was `demoted`, or
 * `insufficient-data` above the risk tier policy allows it to serve).
 * `demoted` capabilities are excluded from candidacy entirely — they are
 * never ranked last, they are never ranked. This module never invokes any
 * fallback path itself; #2385 is a separate, explicitly-invoked escalation.
 *
 * ## Preference override hook (#2396)
 *
 * `decideRoute()` accepts an optional `preferredCapabilityId`. When set, it
 * is consulted as tiebreak step 2.5 — after specificity, after trust rung,
 * BEFORE the lexicographic final tiebreak — so an explicit preference can
 * only ever resolve a tie that specificity and trust left open; it never
 * overrides a structural or trust-based winner. When unset (the default),
 * `pickWinner` behaves exactly as before: this parameter is additive only.
 * `lib/experience/personal-execution-model.js` is the only intended caller
 * of this parameter today.
 */

const TRUST_RUNGS = Object.freeze({
  trusted: 2,
  probationary: 1,
  'insufficient-data': 0,
  // demoted has no rung: it is excluded from candidacy before ranking.
});

const RISK_TIERS = Object.freeze(['low', 'medium', 'high']);

const MATCH_RULE_VERSION = 'structural-subset-v1';
const TIEBREAK_RULE_VERSION = 'specificity-trust-lexicographic-v1';
// No scoring function is implemented (see module doc); this constant is the
// explicit, versioned "not consulted" marker rather than a null/omission.
const SCORE_NOT_USED_VERSION = 'unused-v1';

const REFUSAL_REASONS = Object.freeze({
  NO_STRUCTURAL_MATCH: 'no_structural_match',
  NO_ELIGIBLE_MATCH: 'no_eligible_match',
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Exact subset/superset check: every precondition key/value pair must be
 * present and equal on the request's declared fields. */
function structuralMatch(declared, preconditions) {
  const fields = isRecord(declared) ? declared : {};
  const pre = isRecord(preconditions) ? preconditions : {};
  return Object.keys(pre).every((key) => Object.prototype.hasOwnProperty.call(fields, key)
    && fields[key] === pre[key]);
}

function specificityOf(preconditions) {
  return isRecord(preconditions) ? Object.keys(preconditions).length : 0;
}

function riskTierIndex(tier) {
  const idx = RISK_TIERS.indexOf(tier);
  return idx === -1 ? RISK_TIERS.length - 1 : idx; // unknown tier treated as highest risk
}

/**
 * Whether an `insufficient-data` candidate may serve this request's risk
 * tier. `policy.insufficientDataMaxRiskTier` is a trust-policy-versioned
 * setting the caller supplies (see #2384's design: "risk-tier gating is
 * itself a trust-policy.js-versioned setting, not hardcoded here"); when
 * absent, no gating is applied — insufficient-data candidates are eligible
 * at any tier by default.
 */
function insufficientDataAllowed(request, policy) {
  const ceiling = policy && nonEmptyString(policy.insufficientDataMaxRiskTier)
    ? policy.insufficientDataMaxRiskTier
    : null;
  if (!ceiling) return true;
  const requestTier = request && nonEmptyString(request.riskTier) ? request.riskTier : 'low';
  return riskTierIndex(requestTier) <= riskTierIndex(ceiling);
}

/**
 * Evaluate every candidate for structural match and eligibility, without
 * ranking yet. Returns one annotated row per candidate, in input order —
 * `candidatesConsidered` in the recorded decision is exactly this list.
 */
function evaluateCandidates(request, candidates, policy) {
  return candidates.map((candidate) => {
    const matched = structuralMatch(request && request.declared, candidate.preconditions);
    const trustState = candidate.trustState;
    const excludedByTrust = trustState === 'demoted';
    const excludedByRiskTier = trustState === 'insufficient-data' && !insufficientDataAllowed(request, policy);
    const eligible = matched && !excludedByTrust && !excludedByRiskTier;
    return {
      capabilityId: candidate.capabilityId,
      structuralMatch: matched,
      specificityRank: matched ? specificityOf(candidate.preconditions) : null,
      trustRung: Object.prototype.hasOwnProperty.call(TRUST_RUNGS, trustState) ? TRUST_RUNGS[trustState] : null,
      trustState,
      trustSnapshotVersion: candidate.trustSnapshotVersion || null,
      boundProcedureVersion: candidate.boundProcedureVersion || null,
      eligible,
    };
  });
}

/**
 * Tiebreak order: (1) most specific precondition match, (2) capability
 * trust rung, (2.5) `preferredCapabilityId` when supplied — #2396's PEM
 * override hook, consulted only once (1) and (2) are tied, so it never
 * outranks a structurally or trust-more-specific candidate — (3)
 * lexicographic capabilityId. Step 3 always produces a single winner, so
 * this never needs a distinct "ambiguous" outcome. `preferredCapabilityId`
 * is optional and defaults to unset, in which case step 2.5 is skipped
 * entirely and behavior is identical to the pre-#2396 tiebreak.
 */
function pickWinner(eligibleRows, preferredCapabilityId = null) {
  const sorted = eligibleRows.slice().sort((a, b) => {
    if (b.specificityRank !== a.specificityRank) return b.specificityRank - a.specificityRank;
    if (b.trustRung !== a.trustRung) return b.trustRung - a.trustRung;
    if (preferredCapabilityId) {
      const aPreferred = a.capabilityId === preferredCapabilityId;
      const bPreferred = b.capabilityId === preferredCapabilityId;
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    }
    return a.capabilityId < b.capabilityId ? -1 : a.capabilityId > b.capabilityId ? 1 : 0;
  });
  return sorted[0] || null;
}

/**
 * Decide a route. Deterministic and free of wall-clock/random input, so
 * identical arguments always produce a byte-identical `decision` (acceptance
 * test 1) — no timestamp field is included in the returned record.
 *
 * `candidates`: `[{ capabilityId, preconditions, trustState,
 * boundProcedureVersion, trustSnapshotVersion }]`. `request`: `{ declared,
 * riskTier }`. `policy`: optional `{ insufficientDataMaxRiskTier }`.
 */
function decideRoute({
  requestId, request, candidates, trustSnapshotVersion = null, policy = {},
  matchRuleVersion = MATCH_RULE_VERSION,
  matchScoreVersion = SCORE_NOT_USED_VERSION,
  tiebreakRuleVersion = TIEBREAK_RULE_VERSION,
  preferredCapabilityId = null,
} = {}) {
  if (!nonEmptyString(requestId) || !Array.isArray(candidates)) {
    return { ok: false, code: 'invalid_route_request' };
  }
  const rows = evaluateCandidates(request, candidates, policy);
  const anyStructuralMatch = rows.some((r) => r.structuralMatch);
  const eligible = rows.filter((r) => r.eligible);
  const winner = pickWinner(eligible, nonEmptyString(preferredCapabilityId) ? preferredCapabilityId : null);

  const refusalReason = winner ? null
    : !anyStructuralMatch ? REFUSAL_REASONS.NO_STRUCTURAL_MATCH
      : REFUSAL_REASONS.NO_ELIGIBLE_MATCH;

  const candidatesConsidered = rows.map((r) => Object.freeze({
    capabilityId: r.capabilityId,
    structuralMatch: r.structuralMatch,
    specificityRank: r.specificityRank,
    trustRung: r.trustRung,
    trustSnapshotVersion: r.trustSnapshotVersion,
  }));

  const decision = Object.freeze({
    eventType: 'routing_decided',
    requestId,
    candidatesConsidered: Object.freeze(candidatesConsidered),
    chosenCapabilityId: winner ? winner.capabilityId : null,
    boundProcedureVersion: winner ? winner.boundProcedureVersion : null,
    refusalReason,
    matchRuleVersion,
    matchScoreVersion,
    tiebreakRuleVersion,
    trustSnapshotVersion,
  });
  return { ok: true, decision };
}

module.exports = Object.freeze({
  TRUST_RUNGS,
  RISK_TIERS,
  MATCH_RULE_VERSION,
  TIEBREAK_RULE_VERSION,
  SCORE_NOT_USED_VERSION,
  REFUSAL_REASONS,
  structuralMatch,
  specificityOf,
  decideRoute,
});
