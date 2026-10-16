"use strict";

// Decision rules for lib/risk-classify.js (#2120): the hard-block rules that
// run for every category, and the per-category rule table (#2150).
const {
  ACTION_CATEGORIES,
  ACTION_DECISIONS,
  FLAGS,
  RISK_LEVELS,
} = require('./risk-policy-constants');
const { evaluateFinancialAction } = require('./financial-action-policy');
const { looksLikeProductionTarget } = require('./risk-target-markers');
const { normalizeFlags, uniqueStrings } = require('./risk-classify-normalize');
const { isPathInList, isPathSecuritySensitive, isUrlInList } = require('./risk-classify-targets');

function applyHardBlockRules(input, partial) {
  const contextFlags = uniqueStrings([
    ...normalizeFlags(input?.flags),
    ...normalizeFlags(input?.context?.flags),
  ]);
  const out = {
    ...partial,
    flags: uniqueStrings([...(partial.flags || []), ...contextFlags]),
    reasons: [...(partial.reasons || [])],
  };

  const category = out.category;
  const target = out.target || null;
  const hasFlag = (flag) => out.flags.includes(flag);

  if (hasFlag(FLAGS.AUTO_MERGE)) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Auto-merge is blocked.');
  }

  if (hasFlag(FLAGS.AUTO_DEPLOY)) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Auto-deploy is blocked.');
  }

  if (hasFlag(FLAGS.SELF_ESCALATION)) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Self-escalation is blocked.');
  }

  if (category === ACTION_CATEGORIES.SECURITY_POLICY_CHANGE) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Security policy changes default to block.');
  }

  if (category === ACTION_CATEGORIES.DEPLOYMENT || category === ACTION_CATEGORIES.PERMISSION_CHANGE || category === ACTION_CATEGORIES.PRODUCTION_MUTATION) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED);
    out.reasons.push('Production-side mutation is blocked.');
  }

  if (category === ACTION_CATEGORIES.MEMORY_WRITE || category === ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE || category === ACTION_CATEGORIES.CODE_CHANGE || category === ACTION_CATEGORIES.TEST_CHANGE) {
    if (hasFlag(FLAGS.BYPASS_ADMISSION) || looksLikeProductionTarget(target)) {
      out.decision = ACTION_DECISIONS.BLOCK;
      out.hardBlocked = true;
      out.riskLevel = RISK_LEVELS.CRITICAL;
      out.flags.push(FLAGS.HARD_BLOCKED, FLAGS.PRODUCTION_SIDE);
      out.reasons.push('Admission bypass or production-side target is blocked.');
    }
  }

  if (category === ACTION_CATEGORIES.SANDBOX_SIMULATION && (hasFlag(FLAGS.REAL_DB) || looksLikeProductionTarget(target))) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED, FLAGS.REAL_DB);
    out.reasons.push('Sandbox must not write to a real DB.');
  }

  if (category === ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION && (hasFlag(FLAGS.UNGATED_TOOL_CHAIN) || hasFlag(FLAGS.SELF_ESCALATION))) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED, FLAGS.UNGATED_TOOL_CHAIN);
    out.reasons.push('Tool-chain execution must be gated.');
  }

  if (target && target.path && isPathSecuritySensitive(target.path)) {
    out.decision = ACTION_DECISIONS.BLOCK;
    out.hardBlocked = true;
    out.riskLevel = RISK_LEVELS.CRITICAL;
    out.flags.push(FLAGS.HARD_BLOCKED, FLAGS.PATH_SECURITY_SENSITIVE);
    out.reasons.push('Security-sensitive path is blocked.');
  }

  out.flags = uniqueStrings(out.flags);
  out.reasons = uniqueStrings(out.reasons);
  return out;
}

// #2150: one rule per category; a new category is a row, not a case. Each rule
// sets the category's own risk, decision, flags and reasons on `partial`; the
// hard-block rules still run afterwards for every category.
function reviewRule(reason) {
  return (partial) => {
    partial.riskLevel = RISK_LEVELS.HIGH;
    partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
    partial.reasons.push(reason);
  };
}

function graphWriteRule(reason) {
  return (partial, { target }) => {
    reviewRule(reason)(partial);
    if (looksLikeProductionTarget(target)) {
      partial.flags.push(FLAGS.PRODUCTION_SIDE);
    }
  };
}

function blockRule(reason) {
  return (partial) => {
    partial.riskLevel = RISK_LEVELS.CRITICAL;
    partial.decision = ACTION_DECISIONS.BLOCK;
    partial.reasons.push(reason);
  };
}

function codeChangeRule(partial, { category }) {
  reviewRule(`${category} requires human review.`)(partial);
}

function escalateRead(partial, flag, reason) {
  partial.riskLevel = RISK_LEVELS.HIGH;
  partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
  partial.flags.push(flag);
  partial.reasons.push(reason);
}

function productionRule(partial) {
  blockRule('Production-side actions are blocked.')(partial);
}

function financialRule(partial, { context }) {
  const assessment = evaluateFinancialAction(context?.financial);
  partial.riskLevel = assessment.riskLevel;
  partial.decision = assessment.decision;
  partial.reasons.push(assessment.reason);
}

function unknownCategoryRule(partial) {
  partial.riskLevel = RISK_LEVELS.HIGH;
  partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
  partial.flags.push(FLAGS.UNKNOWN_ACTION_CATEGORY);
  partial.reasons.push('Unknown action category is never silently allowed.');
}

const CATEGORY_RULES = Object.freeze(Object.assign(Object.create(null), {
  [ACTION_CATEGORIES.READ_ONLY]: (partial, { target, allowlistedPaths, allowlistedUrls }) => {
    if (target?.url && !isUrlInList(target.url, allowlistedUrls)) {
      escalateRead(partial, FLAGS.URL_OUTSIDE_ALLOWLIST, 'Read URL is outside the allowlist.');
    } else if (target?.path && !isPathInList(target.path, allowlistedPaths)) {
      escalateRead(partial, FLAGS.PATH_OUTSIDE_ALLOWLIST, 'Read path is outside the allowlist.');
    } else {
      partial.riskLevel = RISK_LEVELS.LOW;
      partial.decision = ACTION_DECISIONS.ALLOW;
      partial.reasons.push('Read-only action stays low risk.');
    }
  },
  [ACTION_CATEGORIES.MEMORY_WRITE]: graphWriteRule('Memory writes require review.'),
  [ACTION_CATEGORIES.CANONICAL_GRAPH_WRITE]: graphWriteRule('Canonical graph writes require review.'),
  [ACTION_CATEGORIES.CODE_CHANGE]: codeChangeRule,
  [ACTION_CATEGORIES.TEST_CHANGE]: codeChangeRule,
  [ACTION_CATEGORIES.SECURITY_POLICY_CHANGE]: blockRule('Security policy changes are blocked by default.'),
  [ACTION_CATEGORIES.DEPLOYMENT]: productionRule,
  [ACTION_CATEGORIES.PERMISSION_CHANGE]: productionRule,
  [ACTION_CATEGORIES.PRODUCTION_MUTATION]: productionRule,
  [ACTION_CATEGORIES.FILESYSTEM_WRITE]: (partial, { target, allowlistedPaths }) => {
    if (target?.path && isPathSecuritySensitive(target.path)) {
      partial.riskLevel = RISK_LEVELS.CRITICAL;
      partial.decision = ACTION_DECISIONS.BLOCK;
      partial.flags.push(FLAGS.PATH_SECURITY_SENSITIVE);
      partial.reasons.push('Security-sensitive path is blocked.');
    } else if (target?.path && isPathInList(target.path, allowlistedPaths)) {
      partial.riskLevel = RISK_LEVELS.MEDIUM;
      partial.decision = ACTION_DECISIONS.QUARANTINE;
      partial.reasons.push('Write path is allowlisted and quarantined.');
    } else {
      partial.riskLevel = RISK_LEVELS.HIGH;
      partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
      if (target?.path) {
        partial.flags.push(FLAGS.PATH_OUTSIDE_ALLOWLIST);
      }
      partial.reasons.push('Filesystem write requires review.');
    }
  },
  [ACTION_CATEGORIES.NETWORK_CALL]: (partial, { target, allowlistedUrls }) => {
    if (target?.url && isUrlInList(target.url, allowlistedUrls)) {
      partial.riskLevel = RISK_LEVELS.MEDIUM;
      partial.decision = ACTION_DECISIONS.QUARANTINE;
      partial.reasons.push('Network destination is allowlisted and quarantined.');
    } else {
      partial.riskLevel = RISK_LEVELS.HIGH;
      partial.decision = ACTION_DECISIONS.HUMAN_REVIEW;
      if (target?.url) {
        partial.flags.push(FLAGS.URL_OUTSIDE_ALLOWLIST);
      }
      partial.reasons.push('Unknown network destination requires review.');
    }
  },
  [ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION]: reviewRule('Tool-chain execution requires review.'),
  [ACTION_CATEGORIES.FINANCIAL_TRANSACTION]: financialRule,
  [ACTION_CATEGORIES.SANDBOX_SIMULATION]: (partial) => {
    partial.riskLevel = RISK_LEVELS.MEDIUM;
    partial.decision = ACTION_DECISIONS.QUARANTINE;
    partial.reasons.push('Sandbox simulation is quarantined.');
  },
}));

module.exports = {
  applyHardBlockRules,
  CATEGORY_RULES,
  unknownCategoryRule,
};
