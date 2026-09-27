"use strict";

// Frozen result and trust-receipt shapes for lib/risk-classify.js (#2120).
const {
  ACTION_DECISIONS,
  FLAGS,
  POLICY_VERSION,
  RISK_LEVELS,
} = require('./risk-policy-constants');
const { isPlainObject } = require('./is-plain-object');
const {
  deepFreeze,
  toArray,
  uniqueStrings,
  normalizeActionType,
  normalizeRiskLevel,
  normalizeDecision,
  normalizeTimestamp,
  cloneTarget,
} = require('./risk-classify-normalize');

function normalizeActionDecision(decisionInput) {
  if (isPlainObject(decisionInput)) {
    const out = {
      ok: decisionInput.ok !== false,
      actionType: normalizeActionType(decisionInput.actionType ?? decisionInput.category ?? decisionInput.actionCategory),
      category: normalizeActionType(decisionInput.category ?? decisionInput.actionType ?? decisionInput.actionCategory),
      actionCategory: normalizeActionType(decisionInput.actionCategory ?? decisionInput.category ?? decisionInput.actionType),
      riskLevel: normalizeRiskLevel(decisionInput.riskLevel),
      decision: normalizeDecision(decisionInput.decision),
      reasons: uniqueStrings(toArray(decisionInput.reasons)),
      flags: uniqueStrings(toArray(decisionInput.flags)),
      hardBlocked: Boolean(decisionInput.hardBlocked),
      trustReceipt: decisionInput.trustReceipt ? normalizeTrustReceipt(decisionInput.trustReceipt) : null,
      policyVersion: typeof decisionInput.policyVersion === 'string' ? decisionInput.policyVersion : POLICY_VERSION,
      target: cloneTarget(decisionInput.target),
      reason: typeof decisionInput.reason === 'string' ? decisionInput.reason : null,
    };
    if (!out.reason && out.reasons.length > 0) {
      out.reason = out.reasons[0];
    }
    return deepFreeze(out);
  }

  return deepFreeze({
    ok: true,
    actionType: null,
    category: null,
    actionCategory: null,
    riskLevel: RISK_LEVELS.HIGH,
    decision: ACTION_DECISIONS.HUMAN_REVIEW,
    reasons: [],
    flags: [FLAGS.MALFORMED_ACTION],
    hardBlocked: false,
    trustReceipt: deepFreeze({
      policyVersion: POLICY_VERSION,
      actionType: null,
      category: null,
      actionCategory: null,
      riskLevel: RISK_LEVELS.HIGH,
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reasons: [],
      flags: [FLAGS.MALFORMED_ACTION],
      hardBlocked: false,
      timestamp: null,
      target: null,
      reason: 'Malformed action input',
    }),
    policyVersion: POLICY_VERSION,
    target: null,
    reason: 'Malformed action input',
  });
}

function buildTrustReceipt(partial) {
  return deepFreeze({
    policyVersion: POLICY_VERSION,
    actionType: partial.actionType,
    category: partial.category,
    actionCategory: partial.actionCategory,
    riskLevel: partial.riskLevel,
    decision: partial.decision,
    reasons: [...partial.reasons],
    flags: [...partial.flags],
    hardBlocked: Boolean(partial.hardBlocked),
    timestamp: normalizeTimestamp(partial.timestamp),
    target: cloneTarget(partial.target),
    reason: partial.reason || (partial.reasons[0] ?? null),
  });
}

function normalizeResultShape(partial) {
  const reasons = uniqueStrings(toArray(partial.reasons));
  const flags = uniqueStrings(toArray(partial.flags));
  const category = partial.category ?? null;
  const decision = normalizeDecision(partial.decision);
  const riskLevel = normalizeRiskLevel(partial.riskLevel);
  const actionType = category;
  const actionCategory = category;
  const trustReceipt = partial.trustReceipt ? normalizeTrustReceipt(partial.trustReceipt) : buildTrustReceipt({
    actionType,
    category,
    actionCategory,
    riskLevel,
    decision,
    reasons,
    flags,
    hardBlocked: Boolean(partial.hardBlocked),
    timestamp: partial.timestamp ?? null,
    target: partial.target ?? null,
    reason: partial.reason ?? null,
  });

  return deepFreeze({
    ok: true,
    actionType,
    category,
    actionCategory,
    riskLevel,
    decision,
    reasons,
    flags,
    hardBlocked: Boolean(partial.hardBlocked),
    requiredReview: decision !== ACTION_DECISIONS.ALLOW,
    blocked: decision !== ACTION_DECISIONS.ALLOW,
    policyVersion: POLICY_VERSION,
    target: cloneTarget(partial.target),
    action: typeof partial.action === 'string' ? partial.action : null,
    reason: partial.reason ?? (reasons[0] ?? null),
    trustReceipt,
  });
}

function normalizeTrustReceipt(receipt) {
  if (!isPlainObject(receipt)) {
    return buildTrustReceipt({
      actionType: null,
      category: null,
      actionCategory: null,
      riskLevel: RISK_LEVELS.HIGH,
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reasons: [],
      flags: [FLAGS.MALFORMED_ACTION],
      hardBlocked: false,
      timestamp: null,
      target: null,
      reason: 'Malformed trust receipt',
    });
  }

  return buildTrustReceipt({
    actionType: normalizeActionType(receipt.actionType ?? receipt.category ?? receipt.actionCategory),
    category: normalizeActionType(receipt.category ?? receipt.actionType ?? receipt.actionCategory),
    actionCategory: normalizeActionType(receipt.actionCategory ?? receipt.category ?? receipt.actionType),
    riskLevel: normalizeRiskLevel(receipt.riskLevel),
    decision: normalizeDecision(receipt.decision),
    reasons: uniqueStrings(toArray(receipt.reasons)),
    flags: uniqueStrings(toArray(receipt.flags)),
    hardBlocked: Boolean(receipt.hardBlocked),
    timestamp: receipt.timestamp ?? null,
    target: cloneTarget(receipt.target),
    reason: typeof receipt.reason === 'string' ? receipt.reason : null,
  });
}

module.exports = {
  normalizeActionDecision,
  buildTrustReceipt,
  normalizeResultShape,
  normalizeTrustReceipt,
};
