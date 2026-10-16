'use strict';

// The sandbox isolation gate's decisions, reasons, risk levels and accepted
// input values, the order that ranks one decision above another, and the
// finding shape every check emits (#2135).

const { normalizeText } = require('./text-utils');

const SANDBOX_ISOLATION_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  QUARANTINE: 'quarantine',
  BLOCK: 'block',
  ROLLBACK: 'rollback',
});

const SANDBOX_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const SANDBOX_ISOLATION_REASONS = Object.freeze({
  SOURCE_VALIDATED_ALLOW: 'SOURCE_VALIDATED_ALLOW',
  SNAPSHOT_RESTORE_ALLOW: 'SNAPSHOT_RESTORE_ALLOW',
  READ_ONLY_EXECUTION_ALLOW: 'READ_ONLY_EXECUTION_ALLOW',
  SANDBOX_VIOLATION_QUARANTINE: 'SANDBOX_VIOLATION_QUARANTINE',
  FORBIDDEN_CAPABILITY_QUARANTINE: 'FORBIDDEN_CAPABILITY_QUARANTINE',
  EXTERNAL_NETWORK_QUARANTINE: 'EXTERNAL_NETWORK_QUARANTINE',
  TEMP_ARTIFACT_OUTSIDE_SANDBOX_QUARANTINE: 'TEMP_ARTIFACT_OUTSIDE_SANDBOX_QUARANTINE',
  TEMP_ARTIFACT_MISSING_SANDBOX_ROOT_QUARANTINE: 'TEMP_ARTIFACT_MISSING_SANDBOX_ROOT_QUARANTINE',
  TEMP_ARTIFACT_PATH_TRAVERSAL_BLOCK: 'TEMP_ARTIFACT_PATH_TRAVERSAL_BLOCK',
  DESTRUCTIVE_CLEANUP_OUTSIDE_SANDBOX_BLOCK: 'DESTRUCTIVE_CLEANUP_OUTSIDE_SANDBOX_BLOCK',
  UNTRUSTED_SOURCE_BLOCK: 'UNTRUSTED_SOURCE_BLOCK',
  UNKNOWN_SOURCE_TRUST_QUARANTINE: 'UNKNOWN_SOURCE_TRUST_QUARANTINE',
  TIMEOUT_EXCEEDED_BLOCK: 'TIMEOUT_EXCEEDED_BLOCK',
  RESOURCE_EXHAUSTION_BLOCK: 'RESOURCE_EXHAUSTION_BLOCK',
  // #1112: this reported RESOURCE_EXHAUSTION_BLOCK, the file's only code/reason
  // mismatch, leaving the two indistinguishable in an audit.
  UNKNOWN_RUNNER_BLOCK: 'UNKNOWN_RUNNER_BLOCK',
  SNAPSHOT_ABUSE_BLOCK: 'SNAPSHOT_ABUSE_BLOCK',
  ROLLBACK_FAILED_ROLLBACK: 'ROLLBACK_FAILED_ROLLBACK',
  SNAPSHOT_INTEGRITY_ROLLBACK: 'SNAPSHOT_INTEGRITY_ROLLBACK',
  STATE_LEAK_DETECTED_ROLLBACK: 'STATE_LEAK_DETECTED_ROLLBACK',
  UNKNOWN_EXECUTION_REVIEW_REQUIRED: 'UNKNOWN_EXECUTION_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
});

const SANDBOX_ISOLATION_POLICY_VERSION = 'AB6-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_TIMEOUT_MS = 150;

const SOURCE_TRUST_LEVELS = Object.freeze({
  VALIDATED: 'validated',
  UNTRUSTED: 'untrusted',
  UNKNOWN: 'unknown',
});

const RUNNER_TYPES = Object.freeze({
  NODE_VM: 'node:vm',
  WORKER: 'worker',
  ISOLATED_VM: 'isolated-vm',
  UNKNOWN: 'unknown',
});

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function decisionRank(decision) {
  const ranks = {
    allow: 0,
    quarantine: 1,
    rollback: 2,
    block: 3,
  };
  return ranks[decision] !== undefined ? ranks[decision] : -1;
}

function decisionFromRank(rank) {
  const byRank = ['allow', 'quarantine', 'rollback', 'block'];
  return byRank[rank] || 'block';
}

function mergeDecision(current, requested) {
  const currentRank = decisionRank(current);
  const requestedRank = decisionRank(requested);
  if (currentRank < 0 || requestedRank < 0) return 'block';
  return currentRank >= requestedRank ? current : requested;
}

function normalizeDecisionLabel(value) {
  const valid = new Set(Object.values(SANDBOX_ISOLATION_DECISIONS));
  const text = normalizeText(value);
  return valid.has(text) ? text : 'block';
}

function normalizeRiskLevel(value) {
  const valid = new Set(Object.values(SANDBOX_RISK_LEVELS));
  const text = normalizeText(value);
  return valid.has(text) ? text : 'medium';
}

function makeFinding(overrides = {}) {
  return {
    code: String(overrides.code || 'UNKNOWN'),
    decision: normalizeDecisionLabel(overrides.decision || 'block'),
    reason: String(overrides.reason || ''),
    risk: normalizeRiskLevel(overrides.risk || 'medium'),
    detail: String(overrides.detail || ''),
  };
}

module.exports = {
  SANDBOX_ISOLATION_DECISIONS,
  SANDBOX_RISK_LEVELS,
  SANDBOX_ISOLATION_REASONS,
  SANDBOX_ISOLATION_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_TIMEOUT_MS,
  SOURCE_TRUST_LEVELS,
  RUNNER_TYPES,
  clampScore,
  decisionRank,
  decisionFromRank,
  mergeDecision,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  makeFinding,
};
