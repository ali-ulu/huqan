'use strict';

// Receipt history reading lives in lib/autonomy-receipt-history.js (#2214);
// hasValidReceiptHash/readReceiptHistory/limits are re-exported below so
// existing importers keep working.
const {
  DEFAULT_RECEIPT_WINDOW,
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

/**
 * Cap a tier claim by what the trust metrics actually justify (#4241).
 *
 * The tier the trail asserts is a claim an agent-writable entry can forge; the
 * metrics behind the promotion policy are the one thing re-derived from the
 * receipts on every evaluation. So the claim may only hold as long as the
 * numbers still support it: a forged `T3` entry on a thin trail resolves to
 * `T1`, which is the tier those metrics authorise. This is the same cap the
 * trust policy applies to an author-supplied confidence (#4245): the asserted
 * value can never lift the decision above the policy-covered one.
 */
function capTierByMetrics(claimedTier, metrics) {
  const justified = [];
  if (metrics.score >= PROMOTION_POLICY.T3.score
      && metrics.totalActions >= PROMOTION_POLICY.T3.minimumActions
      && metrics.successStreak >= PROMOTION_POLICY.T3.successStreak) {
    justified.push('T3');
  }
  if (metrics.score >= PROMOTION_POLICY.T2.score
      && metrics.totalActions >= PROMOTION_POLICY.T2.minimumActions
      && metrics.successStreak >= PROMOTION_POLICY.T2.successStreak) {
    justified.push('T2');
  }
  // The ceiling is the highest tier the policy numbers support, never above
  // what is claimed: the claim still gates how far a promotion may run.
  let ceiling = 'T1';
  for (const candidate of justified) {
    if (AUTONOMY_TIERS[candidate].rank > AUTONOMY_TIERS[ceiling].rank) ceiling = candidate;
  }
  return AUTONOMY_TIERS[claimedTier].rank <= AUTONOMY_TIERS[ceiling].rank
    ? claimedTier
    : ceiling;
}

/**
 * The tier the trust metrics justify on their own.
 *
 * This is the tier a decision may reach regardless of what the trail claims:
 * it is re-derived from the receipts on every evaluation, so an agent that
 * writes a trail entry cannot lift it (#4241).
 */
function metricsTier(metrics) {
  return capTierByMetrics('T3', metrics);
}

function evaluateGraduatedAutonomy(input = {}, options = {}) {
  const identityRef = text(input.identity?.identityRef || input.identityRef);
  if (!identityRef) throw new TypeError('graduated autonomy requires identityRef');
  const evaluatedAt = nowIso(options);
  const receipts = Array.isArray(input.receipts) ? input.receipts : [];
  const metrics = computeTrustScore(receipts, identityRef);
  const state = latestAutonomyState(receipts, identityRef);
  const attested = input.identity?.attested === true;
  // #4241 / CWE-863: the tier read from the trail is a claim, not authority.
  // The trail is agent-writable, and a receipt hash only proves the bytes were
  // not edited -- never who wrote them. So the claimed tier is the baseline a
  // demotion is measured from, and never the ceiling: whatever it says, the
  // decision may only stand where the policy-covered metrics justify it, and
  // the first-human-activation proof is only carried forward from an
  // operator-attested entry. Without that, one appended trail record promotes
  // an identity straight to T3 with `activationRequired: false`.
  const claimedTier = attested ? state.tier : 'T1';
  const ceiling = metricsTier(metrics);
  const fromTier = claimedTier;
  let effectiveTier = demotionTarget(fromTier, metrics, state);
  let transition = effectiveTier !== fromTier
    ? { from: fromTier, to: effectiveTier, status: 'demoted', trigger: metrics.latestViolation ? 'violation' : 'score' }
    : null;
  if (AUTONOMY_TIERS[effectiveTier].rank > AUTONOMY_TIERS[ceiling].rank) {
    effectiveTier = ceiling;
    transition = { from: fromTier, to: effectiveTier, status: 'demoted', trigger: 'score' };
  }
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
      truncated: metrics.truncated,
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
      truncated: metrics.truncated,
      activationRequired,
      attestedIdentity: attested,
      transition: transition?.status || null,
    }),
  });
}

// #4335: the receipt window, counted in receipts (not time): a time window
// admits an unbounded number of receipts, so only a receipt count keeps a
// decision's cost bounded. Resolution order: explicit config beats the
// environment, and the default is DEFAULT_RECEIPT_WINDOW -- the owner's choice
// on #4335. A deployment that wants the pre-#4335 read sets 0 (or the env flag
// to 0). Anything present must be a non-negative integer, and a malformed value
// throws so the gate fails closed instead of silently scoring the whole trail.
function receiptWindowValue(configured, environment) {
  if (configured !== undefined && configured !== null) {
    if (configured === 0) return 0;
    if (!Number.isInteger(configured) || configured < 0 || configured > MAX_HISTORY_RECEIPTS) {
      throw new TypeError(`graduated autonomy receiptWindow must be an integer between 0 and ${MAX_HISTORY_RECEIPTS}`);
    }
    return configured;
  }
  const flag = text(environment.HUQAN_EXTERNAL_GUARD_RECEIPT_WINDOW);
  if (!flag) return DEFAULT_RECEIPT_WINDOW;
  const parsed = Number(flag);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_HISTORY_RECEIPTS) {
    throw new TypeError(`HUQAN_EXTERNAL_GUARD_RECEIPT_WINDOW must be an integer between 0 and ${MAX_HISTORY_RECEIPTS}`);
  }
  return parsed;
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
      identityRef: text(options.identityRef) || undefined,
      receiptWindow: receiptWindowValue(source.receiptWindow, environment),
    }),
    activation: source.activation || null,
    now: options.now,
  };
}

module.exports = {
  AUTONOMY_REASONS,
  AUTONOMY_TIERS,
  DEFAULT_RECEIPT_WINDOW,
  DEMOTION_POLICY,
  GRADUATED_AUTONOMY_VERSION,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_RECEIPTS,
  PROMOTION_POLICY,
  capTierByMetrics,
  computeTrustScore,
  evaluateGraduatedAutonomy,
  graduatedAutonomyOptions,
  hasValidReceiptHash,
  latestAutonomyState,
  readReceiptHistory,
  requiredTierForAction,
};
