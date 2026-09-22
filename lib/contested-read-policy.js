'use strict';

/**
 * Contested-claim read policy (#2788).
 *
 * Maps a reader's declared risk class to how a claim in a contested state is
 * served, per the design posted on #2788 (issuecomment-5784967135,
 * issuecomment-5784993182): a LOW-risk reader sees both sides with no
 * settled value, MEDIUM gets the last-known-good canonical value, HIGH/
 * CRITICAL are blocked outright, and a caller with no declared risk is
 * blocked as a fail-safe default -- the same posture
 * docs/action-taxonomy.md §4 already applies to an unrecognized action
 * category (unknown -> HUMAN_REVIEW, never silent allow).
 *
 * Pure module: no I/O, no graph access. lib/claim-read.js is the caller that
 * wires this against a real trust graph.
 */

const {
  ACTION_CATEGORIES,
  CATEGORY_ALIASES,
  RISK_BY_CATEGORY,
  RISK_LEVELS,
} = require('./risk-policy-constants');
const { riskLevelForScore } = require('./risk-scale');
const { matchesCanonicalTarget } = require('./canonical-target-match');

const CONTESTED_READ_POLICY_VERSION = 'huqan-contested-read-v0.1.0';

const READ_BEHAVIORS = Object.freeze({
  BLOCK: 'block',
  LAST_KNOWN_GOOD: 'last_known_good',
  CONTESTED_MARKER: 'contested_marker',
});

const UNSETTLED_REASONS = Object.freeze({
  CONTESTED_PENDING_TRIAGE: 'contested_pending_triage',
  NO_LAST_KNOWN_GOOD: 'no_last_known_good',
  INTENT_ABSENT: 'intent_absent',
  INTENT_UNRECOGNIZED: 'intent_unrecognized',
  // Reserved for the write-side horizon work (Ali's follow-up on #2788):
  // an admitted-canonical record past its reverification horizon should
  // resolve to this same `unsettled` shape with this reason. Not produced
  // by anything in this module yet.
  AUTHORITY_EXPIRED: 'authority_expired',
});

const READ_BEHAVIOR_BY_RISK_LEVEL = Object.freeze({
  [RISK_LEVELS.LOW]: READ_BEHAVIORS.CONTESTED_MARKER,
  [RISK_LEVELS.MEDIUM]: READ_BEHAVIORS.LAST_KNOWN_GOOD,
  [RISK_LEVELS.HIGH]: READ_BEHAVIORS.BLOCK,
  [RISK_LEVELS.CRITICAL]: READ_BEHAVIORS.BLOCK,
});

const NOT_CONTESTED_CANDIDATE_STATUSES = Object.freeze(['accepted', 'rejected']);

/**
 * Resolve a category (or alias) to a risk level via #2505's taxonomy.
 * Returns `null` when the category is not recognized.
 */
function riskLevelForCategory(category) {
  if (typeof category !== 'string' || !category) return null;
  const canonical = Object.hasOwn(CATEGORY_ALIASES, category)
    ? CATEGORY_ALIASES[category]
    : (Object.hasOwn(ACTION_CATEGORIES, category) ? ACTION_CATEGORIES[category] : null);
  if (!canonical || !Object.hasOwn(RISK_BY_CATEGORY, canonical)) return null;
  return RISK_BY_CATEGORY[canonical];
}

const RISK_LEVEL_ORDER = Object.freeze([
  RISK_LEVELS.LOW,
  RISK_LEVELS.MEDIUM,
  RISK_LEVELS.HIGH,
  RISK_LEVELS.CRITICAL,
]);

function higherLevel(a, b) {
  if (!a) return b;
  if (!b) return a;
  return RISK_LEVEL_ORDER.indexOf(b) > RISK_LEVEL_ORDER.indexOf(a) ? b : a;
}

/**
 * Resolve a reader's risk level from an `intent`: `{category}`,
 * `{riskScore}` (0-100), and/or `{blastRadius}` (a computeBlastRadius()
 * result) may all be given, and the highest level found wins. No new risk
 * scale is introduced here -- every path reuses #2505's existing constants.
 *
 * Returns `{level, source, reason}`. `level` is `null` when nothing could be
 * resolved: no intent at all (`reason: 'intent_absent'`), or an intent whose
 * fields none resolved to a known level (`reason: 'intent_unrecognized'`).
 */
function resolveReaderRiskLevel(intent) {
  if (!intent || typeof intent !== 'object') {
    return { level: null, source: null, reason: UNSETTLED_REASONS.INTENT_ABSENT };
  }

  let level = null;
  let source = null;

  if (typeof intent.category === 'string' && intent.category) {
    const resolved = riskLevelForCategory(intent.category);
    if (resolved) {
      const combined = higherLevel(level, resolved);
      if (combined !== level) source = 'category';
      level = combined;
    }
  }

  if (typeof intent.riskScore === 'number' && Number.isFinite(intent.riskScore)) {
    const resolved = riskLevelForScore(intent.riskScore, RISK_LEVELS);
    if (resolved) {
      const combined = higherLevel(level, resolved);
      if (combined !== level) source = 'riskScore';
      level = combined;
    }
  }

  if (intent.blastRadius && typeof intent.blastRadius === 'object'
    && Number.isFinite(intent.blastRadius.score)) {
    const resolved = riskLevelForScore(intent.blastRadius.score, RISK_LEVELS);
    if (resolved) {
      const combined = higherLevel(level, resolved);
      if (combined !== level) source = 'blastRadius';
      level = combined;
    }
  }

  if (!level) {
    return { level: null, source: null, reason: UNSETTLED_REASONS.INTENT_UNRECOGNIZED };
  }
  return { level, source, reason: null };
}

/**
 * The read behavior for a resolved reader (see `resolveReaderRiskLevel`).
 * `hasLastKnownGood` says whether a canonical value exists to serve if the
 * mapped behavior is `last_known_good` -- when it does not, this escalates to
 * `block` with `reason: 'no_last_known_good'` rather than serving nothing
 * silently under a behavior name that promised a value.
 *
 * Returns `{behavior, reason}`. `reason` is only set when the caller ends up
 * blocked for a reason other than the ordinary contested-pending-triage case
 * (no resolvable risk level, or a missing last-known-good).
 */
function selectReadBehavior(resolution, { hasLastKnownGood = false } = {}) {
  if (!resolution || !resolution.level) {
    return {
      behavior: READ_BEHAVIORS.BLOCK,
      reason: resolution?.reason || UNSETTLED_REASONS.INTENT_ABSENT,
    };
  }

  const behavior = READ_BEHAVIOR_BY_RISK_LEVEL[resolution.level] || READ_BEHAVIORS.BLOCK;
  if (behavior === READ_BEHAVIORS.LAST_KNOWN_GOOD && !hasLastKnownGood) {
    return { behavior: READ_BEHAVIORS.BLOCK, reason: UNSETTLED_REASONS.NO_LAST_KNOWN_GOOD };
  }
  return { behavior, reason: UNSETTLED_REASONS.CONTESTED_PENDING_TRIAGE };
}

/**
 * True iff `candidate` is a live, unresolved conflict against
 * `canonicalRecord` -- i.e. it came out of lib/conflict-detector.js's
 * detectClaimConflict/routeCandidateClaim with a real conflict object
 * (`conflict.conflict === true`), is still flagged for triage
 * (`recommendation === 'flag'`), has not already been reviewed
 * (`status` is neither `accepted` nor `rejected`), and actually targets the
 * canonical record in question.
 *
 * `recommendation === 'flag'` alone is not enough: lib/graph-hypotheses.js
 * and lib/external-client-mutation-receipt-owner.js also write `flag` for
 * diagnosis/review-hold candidates that carry no conflict object at all
 * (`conflict: null` or absent), and those are not contests.
 *
 * lib/contradiction-rules.js's text-level SEMANTIC_OPPOSITION signals are not
 * covered here: that module produces read-time verdicts and saves no stored
 * candidate, so there is nothing yet for this predicate to see. Wiring those
 * signals into the conflict-detector queue is producer-side work under
 * #2144/#2146.
 */
function isContestingCandidate(candidate, canonicalRecord) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (candidate.conflict?.conflict !== true) return false;
  if (candidate.recommendation !== 'flag') return false;
  if (NOT_CONTESTED_CANDIDATE_STATUSES.includes(candidate.status)) return false;
  return matchesCanonicalTarget(candidate, canonicalRecord);
}

module.exports = {
  CONTESTED_READ_POLICY_VERSION,
  READ_BEHAVIORS,
  UNSETTLED_REASONS,
  READ_BEHAVIOR_BY_RISK_LEVEL,
  resolveReaderRiskLevel,
  selectReadBehavior,
  isContestingCandidate,
};
