'use strict';

// The code-change gate's decisions, reasons and risk levels, and the order
// that ranks one decision above another (#2134).

const { normalizeText } = require('./text-utils');

const CODE_CHANGE_GATE_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
  DRY_RUN_ONLY: 'dry_run_only',
});

const CODE_CHANGE_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const CODE_CHANGE_GATE_REASONS = Object.freeze({
  LOW_RISK_DOCS_ONLY: 'LOW_RISK_DOCS_ONLY',
  LOW_RISK_TESTS_ONLY: 'LOW_RISK_TESTS_ONLY',
  NARROW_HELPER_CHANGE: 'NARROW_HELPER_CHANGE',
  SOURCE_CHANGE_REQUIRES_REVIEW: 'SOURCE_CHANGE_REQUIRES_REVIEW',
  RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN: 'RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN',
  PACKAGE_MUTATION_REQUIRES_REVIEW: 'PACKAGE_MUTATION_REQUIRES_REVIEW',
  CI_WORKFLOW_CHANGE_REQUIRES_REVIEW: 'CI_WORKFLOW_CHANGE_REQUIRES_REVIEW',
  RELEASE_OR_DEPLOY_CHANGE_BLOCKED: 'RELEASE_OR_DEPLOY_CHANGE_BLOCKED',
  AUTO_MERGE_OR_AUTOPUSH_BLOCKED: 'AUTO_MERGE_OR_AUTOPUSH_BLOCKED',
  SECRET_CHANGE_BLOCKED: 'SECRET_CHANGE_BLOCKED',
  EMPTY_FILE_LIST_REVIEW_REQUIRED: 'EMPTY_FILE_LIST_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED: 'UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED',
  DIRTY_REPO_REVIEW_REQUIRED: 'DIRTY_REPO_REVIEW_REQUIRED',
  MAIN_BRANCH_WRITE_BLOCKED: 'MAIN_BRANCH_WRITE_BLOCKED',
  BREADTH_REVIEW_REQUIRED: 'BREADTH_REVIEW_REQUIRED',
  CROSS_CUTTING_CHANGE_REVIEW_REQUIRED: 'CROSS_CUTTING_CHANGE_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
  OPERATOR_AUTHORIZED_REVIEW: 'OPERATOR_AUTHORIZED_REVIEW',
});

const CODE_CHANGE_POLICY_VERSION = 'AB3-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

const compareCodePoints = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function normalizeDecisionLabel(value) {
  const text = normalizeText(value);
  if (text === CODE_CHANGE_GATE_DECISIONS.ALLOW) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (text === CODE_CHANGE_GATE_DECISIONS.REVIEW) return CODE_CHANGE_GATE_DECISIONS.REVIEW;
  if (text === CODE_CHANGE_GATE_DECISIONS.BLOCK) return CODE_CHANGE_GATE_DECISIONS.BLOCK;
  if (text === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY) return CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY;
  return '';
}

function normalizeRiskLevel(value) {
  const text = normalizeText(value);
  if (text === 'low' || text === 'minimal') return CODE_CHANGE_RISK_LEVELS.LOW;
  if (text === 'medium' || text === 'moderate') return CODE_CHANGE_RISK_LEVELS.MEDIUM;
  if (text === 'high') return CODE_CHANGE_RISK_LEVELS.HIGH;
  if (text === 'critical' || text === 'severe') return CODE_CHANGE_RISK_LEVELS.CRITICAL;
  return CODE_CHANGE_RISK_LEVELS.MEDIUM;
}

function clampScore(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function decisionRank(decision) {
  const normalized = normalizeDecisionLabel(decision);
  if (normalized === CODE_CHANGE_GATE_DECISIONS.ALLOW) return 0;
  if (normalized === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY) return 1;
  if (normalized === CODE_CHANGE_GATE_DECISIONS.REVIEW) return 2;
  if (normalized === CODE_CHANGE_GATE_DECISIONS.BLOCK) return 3;
  return 2;
}

function decisionFromRank(rank) {
  if (rank <= 0) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (rank === 1) return CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY;
  if (rank === 2) return CODE_CHANGE_GATE_DECISIONS.REVIEW;
  return CODE_CHANGE_GATE_DECISIONS.BLOCK;
}

function mergeDecision(current, requested) {
  return decisionFromRank(Math.max(decisionRank(current), decisionRank(requested)));
}

function reasonToDecision(reason) {
  if (reason === CODE_CHANGE_GATE_REASONS.LOW_RISK_DOCS_ONLY) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (reason === CODE_CHANGE_GATE_REASONS.LOW_RISK_TESTS_ONLY) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (reason === CODE_CHANGE_GATE_REASONS.NARROW_HELPER_CHANGE) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (reason === CODE_CHANGE_GATE_REASONS.RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN) return CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY;
  if (reason === CODE_CHANGE_GATE_REASONS.RELEASE_OR_DEPLOY_CHANGE_BLOCKED) return CODE_CHANGE_GATE_DECISIONS.BLOCK;
  if (reason === CODE_CHANGE_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED) return CODE_CHANGE_GATE_DECISIONS.BLOCK;
  if (reason === CODE_CHANGE_GATE_REASONS.SECRET_CHANGE_BLOCKED) return CODE_CHANGE_GATE_DECISIONS.BLOCK;
  return CODE_CHANGE_GATE_DECISIONS.REVIEW;
}

module.exports = {
  CODE_CHANGE_GATE_DECISIONS,
  CODE_CHANGE_RISK_LEVELS,
  CODE_CHANGE_GATE_REASONS,
  CODE_CHANGE_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  firstText,
  normalizePath,
  compareCodePoints,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  clampScore,
  decisionRank,
  mergeDecision,
  reasonToDecision,
};
