"use strict";
const {
  ACTION_CATEGORIES,
  ACTION_DECISIONS,
  FLAGS,
  HIGH_IMPACT_WRITE_CATEGORIES,

  LEGACY_DECISIONS,
  LEGACY_RISK_LEVELS,
  POLICY_VERSION,
  RISK_BY_CATEGORY,
  RISK_LEVELS,
  SECURITY_SENSITIVE_PATH_TOKENS,
} = require("./risk-policy-constants");
// #2120: the normalizers, path/URL matchers, result shapes and decision rules
// live in lib/risk-classify-*.js; this file composes them and owns the public
// surface (the module.exports shape below is unchanged).
const {
  uniqueStrings,
  normalizeActionType,
  normalizeRiskLevel,
  normalizeDecision,
  normalizeTimestamp,
  normalizeFlags,
  normalizeActionRequest,
} = require('./risk-classify-normalize');
const { isPathInList, isPathSecuritySensitive, isUrlInList } = require('./risk-classify-targets');
const { normalizeActionDecision, buildTrustReceipt, normalizeResultShape } = require('./risk-classify-receipt');
const { applyHardBlockRules, CATEGORY_RULES, unknownCategoryRule } = require('./risk-classify-rules');

function classifyActionCategory(action) {
  const normalized = normalizeActionRequest(action);
  return normalized.malformed ? null : normalized.category;
}

function resolveRiskLevel(category) {
  if (!category || !ACTION_CATEGORIES[category]) {
    return RISK_LEVELS.HIGH;
  }
  return RISK_BY_CATEGORY[category] || RISK_LEVELS.HIGH;
}

function deriveDecision(riskLevel, hardBlocked) {
  if (hardBlocked) {
    return ACTION_DECISIONS.BLOCK;
  }
  switch (normalizeRiskLevel(riskLevel)) {
    case RISK_LEVELS.LOW:
      return ACTION_DECISIONS.ALLOW;
    case RISK_LEVELS.MEDIUM:
      return ACTION_DECISIONS.QUARANTINE;
    case RISK_LEVELS.HIGH:
      return ACTION_DECISIONS.HUMAN_REVIEW;
    case RISK_LEVELS.CRITICAL:
      return ACTION_DECISIONS.BLOCK;
    default:
      return ACTION_DECISIONS.HUMAN_REVIEW;
  }
}

function classifyAgentAction(actionInput, options = {}) {
  const normalized = normalizeActionRequest(actionInput);
  const optFlags = uniqueStrings([
    ...normalizeFlags(options.flags),
    ...normalizeFlags(options.context?.flags),
  ]);

  if (normalized.malformed || !normalized.category) {
    const base = normalizeResultShape({
      actionType: null,
      category: null,
      actionCategory: null,
      riskLevel: RISK_LEVELS.HIGH,
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reasons: normalized.malformed ? ['Malformed action input'] : ['Unknown action category'],
      flags: uniqueStrings([
        ...normalized.flags,
        ...optFlags,
        normalized.malformed ? FLAGS.MALFORMED_ACTION : FLAGS.UNKNOWN_ACTION_CATEGORY,
      ]),
      hardBlocked: false,
      target: normalized.target,
      action: normalized.action,
      timestamp: normalizeTimestamp(options.now ?? normalized.now),
      reason: normalized.malformed ? 'Malformed action input' : 'Unknown action category',
    });
    return base;
  }

  const category = normalized.category;
  const allowlistedPaths = options.allowlistedPaths ?? normalized.context.allowlistedPaths ?? [];
  const allowlistedUrls = options.allowlistedUrls ?? normalized.context.allowlistedUrls ?? [];
  const target = normalized.target;
  const baseRisk = resolveRiskLevel(category);
  const partial = {
    actionType: category,
    category,
    actionCategory: category,
    riskLevel: baseRisk,
    decision: deriveDecision(baseRisk, false),
    flags: [...normalized.flags, ...optFlags],
    reasons: [],
    hardBlocked: false,
    target,
    action: normalized.action,
    timestamp: normalizeTimestamp(options.now ?? normalized.now),
    reason: null,
  };

  const rule = Object.hasOwn(CATEGORY_RULES, category) ? CATEGORY_RULES[category] : unknownCategoryRule;
  rule(partial, { category, target, allowlistedPaths, allowlistedUrls, context: normalized.context });

  const hardened = applyHardBlockRules({
    context: {
      flags: [...normalized.flags, ...optFlags],
    },
  }, partial);

  if (hardened.decision === ACTION_DECISIONS.BLOCK) {
    hardened.flags.push(FLAGS.HARD_BLOCKED);
  }

  hardened.reason = hardened.reason || hardened.reasons[0] || null;
  hardened.timestamp = normalizeTimestamp(options.now ?? normalized.now);
  hardened.trustReceipt = buildTrustReceipt(hardened);
  return normalizeResultShape(hardened);
}

function classify(actionInput, options = {}) {
  return classifyAgentAction(actionInput, options);
}

module.exports = {
  ACTION_CATEGORIES,
  ACTION_TYPES: ACTION_CATEGORIES,
  ACTION_DECISIONS,
  DECISIONS: ACTION_DECISIONS,
  RISK_LEVELS,
  LEGACY_RISK_LEVELS,
  LEGACY_DECISIONS,
  FLAGS,
  SECURITY_SENSITIVE_PATH_TOKENS,
  HIGH_IMPACT_WRITE_CATEGORIES,
  POLICY_VERSION,
  normalizeActionType,
  normalizeActionRequest,
  classifyActionCategory,
  resolveRiskLevel,
  deriveDecision,
  applyHardBlockRules,
  classifyAgentAction,
  classify,
  normalizeActionDecision,
  normalizeDecision,
  isPathInList,
  isPathSecuritySensitive,
  isUrlInList,
};
