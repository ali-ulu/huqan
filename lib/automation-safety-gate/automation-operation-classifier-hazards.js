'use strict';

// Phase 2 of classifyAutomationOperation (#2176): repository hazards, from
// auto-merge through settings changes, in their original precedence order.
// Returns the finding, or null for the next phase.

const { AUTOMATION_SAFETY_DECISIONS, AUTOMATION_RISK_LEVELS, AUTOMATION_SAFETY_REASONS, AUTO_MERGE_HINTS, FORCE_PUSH_HINTS, HISTORY_REWRITE_HINTS, BRANCH_PROTECTION_HINTS, CI_BYPASS_HINTS, WORKFLOW_HINTS, DESTRUCTIVE_HINTS, TOKEN_PERSISTENCE_HINTS, BRANCH_DELETE_HINTS, SETTINGS_CHANGE_HINTS } = require('./automation-safety-vocabulary');
const { containsAny, signalsEqual, makeFinding } = require('./automation-input-normalizer');

function classifyHazardPhase(ctx) {
  const { normalized, opType, opText, explicitApproval } = ctx;

  if (containsAny(opText, AUTO_MERGE_HINTS) || signalsEqual(opType, 'enable_auto_merge') || containsAny(opText, ['enable auto merge'])) {
    return makeFinding({
      operationType: opType,
      category: 'auto_merge',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.ENABLE_AUTO_MERGE_BLOCKED,
      notes: ['Auto-merge would create autonomous future mutations.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, FORCE_PUSH_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'force_push',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.FORCE_PUSH_BLOCKED,
      notes: ['Force push rewrites shared history.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, HISTORY_REWRITE_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'history_rewrite',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.HISTORY_REWRITE_BLOCKED,
      notes: ['History rewrite is not allowed through the automation gate.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, BRANCH_PROTECTION_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'branch_protection',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.BRANCH_PROTECTION_BYPASS_BLOCKED,
      notes: ['Branch protection mutation or bypass is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, CI_BYPASS_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'ci_bypass',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.CI_BYPASS_BLOCKED,
      notes: ['CI bypass would remove the control plane from the release path.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, DESTRUCTIVE_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'destructive_cleanup',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.DESTRUCTIVE_CLEANUP_BLOCKED,
      notes: ['Destructive cleanup is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, TOKEN_PERSISTENCE_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'token_persistence',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.TOKEN_PERSISTENCE_BLOCKED,
      notes: ['Token or secret persistence is blocked.'],
      sensitive: true,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, ['workflow_abuse'])) {
    return makeFinding({
      operationType: opType,
      category: 'workflow_abuse',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.WORKFLOW_ABUSE_BLOCKED,
      notes: ['Workflow abuse is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, ['workflow_dispatch']) || containsAny(opText, WORKFLOW_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'workflow',
      riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
      riskScore: 0.7,
      decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: AUTOMATION_SAFETY_REASONS.WORKFLOW_DISPATCH_REVIEW_REQUIRED,
      notes: ['Workflow dispatch or workflow edit requires review.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  if (containsAny(opText, BRANCH_DELETE_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'branch_delete',
      riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
      riskScore: 0.75,
      decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: AUTOMATION_SAFETY_REASONS.BRANCH_DELETE_REVIEW_REQUIRED,
      notes: ['Branch deletion should be reviewed before execution.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  if (containsAny(opText, SETTINGS_CHANGE_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'repo_settings',
      riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
      riskScore: 0.8,
      decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: AUTOMATION_SAFETY_REASONS.REPO_SETTINGS_CHANGE_REVIEW_REQUIRED,
      notes: ['Repository settings changes require review.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  return null;
}

module.exports = { classifyHazardPhase };
