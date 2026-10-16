'use strict';

// Trust score aggregation for graduated autonomy (#2214).
//
// Single responsibility: turn the filtered, grouped receipt trail into the
// bounded score the tier policy reasons about — success/violation/review
// counts, streak, latest violation. No I/O, no tier policy, no state
// transitions, no orchestration. Those stay in lib/graduated-autonomy.js.

const {
  belongsToIdentity,
  hasValidReceiptHash,
  isAdmissionReceipt,
  isOutcomeReceipt,
} = require('./autonomy-receipt-history');

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

module.exports = { actionRows, computeTrustScore };
