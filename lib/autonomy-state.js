'use strict';

// Tier policy and state transitions for graduated autonomy (#2214).
//
// Single responsibility:own the tier vocabulary, the promotion/demotion
// thresholds and the persisted-state reading that the orchestrator reasons
// about. No scoring, no receipt I/O, no top-level orchestration. The
// orchestrator in lib/graduated-autonomy.js re-exports the constants so
// existing importers keep working. This module is never a second authority
// for the final allow/review decision.

const { ACTION_CATEGORIES } = require('./action-risk-classifier');
const { belongsToIdentity, hasValidReceiptHash } = require('./autonomy-receipt-history');

const GRADUATED_AUTONOMY_VERSION = 'huqan.graduated-autonomy.v1';

const AUTONOMY_TIERS = Object.freeze({
  T1: Object.freeze({ id: 'T1', rank: 1, label: 'read_only' }),
  T2: Object.freeze({ id: 'T2', rank: 2, label: 'restricted_write' }),
  T3: Object.freeze({ id: 'T3', rank: 3, label: 'expanded' }),
});

const PROMOTION_POLICY = Object.freeze({
  T2: Object.freeze({ score: 75, minimumActions: 10, successStreak: 5 }),
  T3: Object.freeze({ score: 90, minimumActions: 30, successStreak: 10 }),
});

const DEMOTION_POLICY = Object.freeze({ T2: 60, T3: 80 });

const TIER_CATEGORIES = Object.freeze({
  T1: Object.freeze([
    ACTION_CATEGORIES.READ_ONLY,
    ACTION_CATEGORIES.SANDBOX_SIMULATION,
  ]),
  T2: Object.freeze([
    ACTION_CATEGORIES.READ_ONLY,
    ACTION_CATEGORIES.SANDBOX_SIMULATION,
    ACTION_CATEGORIES.FILESYSTEM_WRITE,
    ACTION_CATEGORIES.MEMORY_WRITE,
  ]),
});

const AUTONOMY_REASONS = Object.freeze({
  ALLOWED: 'autonomy_tier_allows_action',
  ACTIVATION_REQUIRED: 'autonomy_first_promotion_requires_human_activation',
  ATTESTED_IDENTITY_REQUIRED: 'autonomy_promotion_requires_attested_identity',
  TIER_INSUFFICIENT: 'autonomy_tier_insufficient',
  HISTORY_INVALID: 'autonomy_history_invalid',
});

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tier(value, fallback = 'T1') {
  const normalized = text(value).toUpperCase();
  return AUTONOMY_TIERS[normalized] ? normalized : fallback;
}

function previousTier(value) {
  if (value === 'T3') return 'T2';
  return 'T1';
}

function nextTier(value) {
  if (value === 'T1') return 'T2';
  if (value === 'T2') return 'T3';
  return 'T3';
}

/**
 * The tier the trail asserts. A claim, not authority: the trail is
 * agent-writable and a receipt hash only proves the bytes were not edited --
 * never who wrote them (#4241, CWE-863). `graduated-autonomy.js` re-derives
 * the tier the decision may honour from the policy-covered metrics.
 */
function callerTier(entry) {
  return tier(entry?.metadata?.autonomy?.tier);
}

function latestAutonomyState(receipts, identityRef) {
  const matching = (Array.isArray(receipts) ? receipts : [])
    .filter(hasValidReceiptHash)
    .filter(receipt => belongsToIdentity(receipt, identityRef))
    .filter(receipt => receipt?.metadata?.autonomy?.schemaVersion === GRADUATED_AUTONOMY_VERSION)
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
  // The most recent entry the trail asserts.
  const latest = matching[0];
  if (!latest) return Object.freeze({ tier: 'T1', evaluatedAt: null, firstActivation: null });
  // The first-human-activation proof is the one field that must never come
  // from an agent-writable entry: honouring a forged `firstActivation` is what
  // lets a T1 identity claim `activationRequired: false` against T3 (#4241).
  // Only an operator-attested entry -- one the operator-side caller resolved
  // through the approval authority (lib/authority/autonomy-activation.js) --
  // may carry it forward. An agent appending to its own trail cannot produce
  // that attestation, because it has no authority client to sign with.
  const attested = matching.find(entry => entry?.metadata?.autonomy?.operatorAttested === true);
  return Object.freeze({
    tier: callerTier(latest),
    evaluatedAt: text(latest.metadata.autonomy.evaluatedAt) || latest.createdAt || null,
    firstActivation: attested && typeof attested.metadata.autonomy.firstActivation === 'object'
      ? Object.freeze({ ...attested.metadata.autonomy.firstActivation })
      : null,
  });
}

function normalizeHumanActivation(input, evaluatedAt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const approvalId = text(input.approvalId);
  const actor = text(input.actor);
  const actorType = text(input.actorType).toLowerCase();
  const approvedAt = text(input.approvedAt);
  if (input.status !== 'approved' || !approvalId || !actor || actorType !== 'human' || !timestamp(approvedAt)) return null;
  if (timestamp(approvedAt) > timestamp(evaluatedAt)) return null;
  return Object.freeze({ approvalId, actor, actorType: 'human', approvedAt });
}

function requiredTierForAction(action = {}) {
  const category = text(action.riskCategory || action.category).toUpperCase();
  if (TIER_CATEGORIES.T1.includes(category)) return 'T1';
  if (TIER_CATEGORIES.T2.includes(category)) return 'T2';
  return 'T3';
}

function promotionEligible(currentTier, metrics) {
  const target = nextTier(currentTier);
  if (target === currentTier) return false;
  const policy = PROMOTION_POLICY[target];
  return metrics.score >= policy.score
    && metrics.totalActions >= policy.minimumActions
    && metrics.successStreak >= policy.successStreak;
}

function demotionTarget(currentTier, metrics, state) {
  const unseenViolation = metrics.latestViolation
    && timestamp(metrics.latestViolation.createdAt) > timestamp(state.evaluatedAt);
  if (unseenViolation) return metrics.latestViolation.critical ? 'T1' : previousTier(currentTier);
  if (currentTier === 'T3' && metrics.score < DEMOTION_POLICY.T3) {
    return metrics.score < DEMOTION_POLICY.T2 ? 'T1' : 'T2';
  }
  if (currentTier === 'T2' && metrics.score < DEMOTION_POLICY.T2) return 'T1';
  return currentTier;
}

module.exports = {
  AUTONOMY_REASONS,
  AUTONOMY_TIERS,
  DEMOTION_POLICY,
  GRADUATED_AUTONOMY_VERSION,
  PROMOTION_POLICY,
  TIER_CATEGORIES,
  demotionTarget,
  latestAutonomyState,
  nextTier,
  normalizeHumanActivation,
  previousTier,
  promotionEligible,
  requiredTierForAction,
  tier,
};
