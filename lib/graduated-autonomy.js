'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ACTION_CATEGORIES } = require('./action-risk-classifier');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');
const { hashCanonicalReceiptPayload } = require('./receipt/canonical-receipt');

const GRADUATED_AUTONOMY_VERSION = 'huqan.graduated-autonomy.v1';
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_RECEIPTS = 10_000;

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

function nowIso(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date().toISOString();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('graduated autonomy requires a valid clock');
  return parsed.toISOString();
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

function identityRefFor(receipt) {
  return text(receipt?.metadata?.identity?.identityRef);
}

function belongsToIdentity(receipt, identityRef) {
  return identityRefFor(receipt) === identityRef;
}

function hasValidReceiptHash(receipt) {
  const supplied = text(receipt?.receiptHash).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  try {
    const payload = { ...receipt };
    delete payload.receiptHash;
    return hashCanonicalReceiptPayload(payload) === supplied;
  } catch (_) {
    return false;
  }
}

function isAdmissionReceipt(receipt) {
  return [
    'external_action_admission_receipt',
    'external_action_review_receipt',
    'external_action_rejection_receipt',
  ].includes(receipt?.receiptKind);
}

function isOutcomeReceipt(receipt) {
  return receipt?.receiptKind === 'external_action_outcome_receipt';
}

function readReceiptHistory(options = {}) {
  if (Array.isArray(options.receipts)) return options.receipts.slice(-MAX_HISTORY_RECEIPTS);
  const environment = options.environment || process.env;
  const target = path.resolve(options.path || defaultExternalActionReceiptPath(environment));
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  const start = Math.max(0, stat.size - MAX_HISTORY_BYTES);
  const buffer = Buffer.alloc(stat.size - start);
  const fd = fs.openSync(target, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  let raw = buffer.toString('utf8');
  if (start > 0) raw = raw.slice(Math.max(0, raw.indexOf('\n') + 1));
  const receipts = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) receipts.push(parsed);
    } catch (_) {
      // A damaged line cannot contribute positive evidence. Other valid,
      // hash-bearing receipts remain usable and the skipped line is never
      // interpreted as success.
    }
  }
  return receipts.slice(-MAX_HISTORY_RECEIPTS);
}

function actionRows(receipts, identityRef) {
  const grouped = new Map();
  const ordered = receipts
    .filter(hasValidReceiptHash)
    .filter(receipt => belongsToIdentity(receipt, identityRef))
    .filter(receipt => isAdmissionReceipt(receipt) || isOutcomeReceipt(receipt))
    .sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt));
  for (const receipt of ordered) {
    const key = text(receipt.admissionId);
    if (!key) continue;
    const row = grouped.get(key) || { admissionId: key, createdAt: '', admission: null, outcome: null };
    row.createdAt = timestamp(receipt.createdAt) >= timestamp(row.createdAt) ? receipt.createdAt : row.createdAt;
    if (isAdmissionReceipt(receipt)) row.admission = receipt;
    if (isOutcomeReceipt(receipt)) row.outcome = receipt;
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt));
}

function computeTrustScore(receipts, identityRef) {
  const actions = actionRows(Array.isArray(receipts) ? receipts : [], identityRef);
  let successes = 0;
  let violations = 0;
  let reviews = 0;
  let successStreak = 0;
  let latestViolation = null;

  for (const action of actions) {
    const reviewed = action.admission?.decision === 'review' || action.admission?.status === 'review';
    const quarantined = action.outcome?.metadata?.monitoring?.quarantine?.applied === true;
    const critical = action.admission?.decision === 'block' || action.outcome?.status === 'blocked' || quarantined;
    const violated = critical || action.outcome?.status === 'failed';
    const succeeded = action.outcome?.status === 'executed' && !reviewed && !violated;
    if (reviewed) reviews += 1;
    if (violated) {
      violations += 1;
      latestViolation = Object.freeze({
        admissionId: action.admissionId,
        createdAt: action.createdAt,
        critical,
        source: quarantined ? 'post_action_anomaly' : 'action_outcome',
      });
    }
    if (succeeded) {
      successes += 1;
      successStreak += 1;
    } else {
      successStreak = 0;
    }
  }

  const total = actions.length;
  const successRate = total ? successes / total : 0;
  const violationRate = total ? violations / total : 0;
  const reviewRate = total ? reviews / total : 0;
  const score = total
    ? Math.round(100 * ((0.7 * successRate) + (0.2 * (1 - violationRate)) + (0.1 * (1 - reviewRate))))
    : 0;
  return Object.freeze({
    score,
    totalActions: total,
    successes,
    violations,
    reviews,
    successRate,
    violationRate,
    reviewRate,
    successStreak,
    latestActionAt: actions.at(-1)?.createdAt || null,
    latestViolation,
  });
}

function latestAutonomyState(receipts, identityRef) {
  const matching = (Array.isArray(receipts) ? receipts : [])
    .filter(hasValidReceiptHash)
    .filter(receipt => belongsToIdentity(receipt, identityRef))
    .filter(receipt => receipt?.metadata?.autonomy?.schemaVersion === GRADUATED_AUTONOMY_VERSION)
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
  const autonomy = matching[0]?.metadata?.autonomy;
  if (!autonomy) return Object.freeze({ tier: 'T1', evaluatedAt: null, firstActivation: null });
  return Object.freeze({
    tier: tier(autonomy.tier),
    evaluatedAt: text(autonomy.evaluatedAt) || matching[0].createdAt || null,
    firstActivation: autonomy.firstActivation && typeof autonomy.firstActivation === 'object'
      ? Object.freeze({ ...autonomy.firstActivation })
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
  const envEnabled = /^(?:1|true|yes|on)$/i.test(text(environment.HUQAN_EXTERNAL_GUARD_GRADUATED_AUTONOMY));
  if (config !== true && !config?.enabled && !envEnabled) return null;
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
