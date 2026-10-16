'use strict';

// Receipt history reading lives in lib/autonomy-receipt-history.js (#2214);
// hasValidReceiptHash/readReceiptHistory/limits are re-exported below so
// existing importers keep working.
const {
  MAX_HISTORY_BYTES,
  MAX_HISTORY_RECEIPTS,
  belongsToIdentity,
  hasValidReceiptHash,
  isAdmissionReceipt,
  isOutcomeReceipt,
  readReceiptHistory,
} = require('./autonomy-receipt-history');
const { computeTrustScore } = require('./autonomy-trust-score');
const {
  AUTONOMY_REASONS,
  AUTONOMY_TIERS,
  DEMOTION_POLICY,
  GRADUATED_AUTONOMY_VERSION,
  PROMOTION_POLICY,
  demotionTarget,
  latestAutonomyState,
  nextTier,
  normalizeHumanActivation,
  promotionEligible,
  requiredTierForAction,
} = require('./autonomy-state');

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nowIso(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date().toISOString();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('graduated autonomy requires a valid clock');
  return parsed.toISOString();
}

function evaluateGraduatedAutonomy(input = {}, options = {}) {
  const identityRef = text(input.identity?.identityRef || input.identityRef);
  if (!identityRef) throw new TypeError('graduated autonomy requires identityRef');
  const evaluatedAt = nowIso(options);
  const receipts = Array.isArray(input.receipts) ? input.receipts : [];
  const metrics = computeTrustScore(receipts, identityRef);
  const state = latestAutonomyState(receipts, identityRef);
  const attested = input.identity?.attested === true;
  const fromTier = attested ? state.tier : 'T1';
  let effectiveTier = demotionTarget(fromTier, metrics, state);
  let transition = effectiveTier !== fromTier
    ? { from: fromTier, to: effectiveTier, status: 'demoted', trigger: metrics.latestViolation ? 'violation' : 'score' }
    : null;
  let firstActivation = state.firstActivation;
  let activationRequired = false;

  if (!transition && attested && promotionEligible(fromTier, metrics)) {
    const proposed = nextTier(fromTier);
    if (!firstActivation) {
      const supplied = normalizeHumanActivation(input.activation, evaluatedAt);
      if (!supplied) {
        activationRequired = true;
        transition = { from: fromTier, to: proposed, status: 'activation_required', trigger: 'score' };
      } else {
        firstActivation = supplied;
        effectiveTier = proposed;
        transition = { from: fromTier, to: proposed, status: 'promoted', trigger: 'score_and_human_activation' };
      }
    } else {
      effectiveTier = proposed;
      transition = { from: fromTier, to: proposed, status: 'promoted', trigger: 'score' };
    }
  }

  const requiredTier = requiredTierForAction(input.action);
  const authorized = AUTONOMY_TIERS[effectiveTier].rank >= AUTONOMY_TIERS[requiredTier].rank;
  const reason = authorized
    ? AUTONOMY_REASONS.ALLOWED
    : !attested && metrics.score >= PROMOTION_POLICY.T2.score
      ? AUTONOMY_REASONS.ATTESTED_IDENTITY_REQUIRED
    : activationRequired
      ? AUTONOMY_REASONS.ACTIVATION_REQUIRED
      : AUTONOMY_REASONS.TIER_INSUFFICIENT;
  const autonomy = Object.freeze({
    schemaVersion: GRADUATED_AUTONOMY_VERSION,
    identityRef,
    tier: effectiveTier,
    tierLabel: AUTONOMY_TIERS[effectiveTier].label,
    requiredTier,
    score: metrics.score,
    ratios: Object.freeze({
      success: metrics.successRate,
      violation: metrics.violationRate,
      review: metrics.reviewRate,
    }),
    evidence: Object.freeze({
      totalActions: metrics.totalActions,
      successes: metrics.successes,
      violations: metrics.violations,
      reviews: metrics.reviews,
      successStreak: metrics.successStreak,
    }),
    evaluatedAt,
    activationRequired,
    attestedIdentity: attested,
    firstActivation,
    transition: transition ? Object.freeze({ ...transition }) : null,
  });
  return Object.freeze({
    ok: true,
    authorized,
    decision: authorized ? 'allow' : 'review',
    reason,
    autonomy,
    finding: Object.freeze({
      gate: 'graduated-autonomy',
      decision: authorized ? 'allow' : 'review',
      reason,
      tier: effectiveTier,
      requiredTier,
      score: metrics.score,
      activationRequired,
      attestedIdentity: attested,
      transition: transition?.status || null,
    }),
  });
}

function graduatedAutonomyOptions(options = {}) {
  const config = options.graduatedAutonomy;
  const environment = options.environment || process.env;
  const envFlag = text(environment.HUQAN_EXTERNAL_GUARD_GRADUATED_AUTONOMY);
  // Explicit opt-out restores the pre-Faz-D behaviour (#2157). It beats the
  // default so a deployment can go back to having no tier ceiling.
  if (config && typeof config === 'object' && config.enabled === false) return null;
  if (config === undefined && /^(?:0|false|off|no|disabled)$/i.test(envFlag)) return null;
  const source = config && typeof config === 'object' ? config : {};
  return {
    receipts: readReceiptHistory({
      receipts: source.receipts,
      path: source.receiptPath || options.receiptWriter?.path,
      environment,
    }),
    activation: source.activation || null,
    now: options.now,
  };
}

module.exports = {
  AUTONOMY_REASONS,
  AUTONOMY_TIERS,
  DEMOTION_POLICY,
  GRADUATED_AUTONOMY_VERSION,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_RECEIPTS,
  PROMOTION_POLICY,
  computeTrustScore,
  evaluateGraduatedAutonomy,
  graduatedAutonomyOptions,
  hasValidReceiptHash,
  latestAutonomyState,
  readReceiptHistory,
  requiredTierForAction,
};
