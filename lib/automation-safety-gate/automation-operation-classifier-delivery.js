'use strict';

// Phase 3 of classifyAutomationOperation (#2176): deploy, release and merge,
// each with its approval paths. Returns the finding, or null for the last
// phase.

const { AUTOMATION_SAFETY_DECISIONS, AUTOMATION_RISK_LEVELS, AUTOMATION_SAFETY_REASONS, DEPLOY_HINTS, RELEASE_HINTS, MERGE_HINTS } = require('./automation-safety-vocabulary');
const { containsAny, signalsEqual, makeFinding } = require('./automation-input-normalizer');

function classifyDeliveryPhase(ctx) {
  const { normalized, opType, opText, explicitApproval, approvedMergePath } = ctx;

  if (containsAny(opText, DEPLOY_HINTS)) {
    if (normalized.previewRequested || normalized.deploy?.preview || normalized.deploy?.dryRun) {
      return makeFinding({
        operationType: opType,
        category: 'deploy_preview',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.8,
        decision: AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
        reason: AUTOMATION_SAFETY_REASONS.DEPLOY_PREVIEW_ONLY,
        notes: ['Deploy preview can be generated safely, but execution must wait.'],
        sensitive: false,
        explicitApproval,
        previewRequested: true,
      });
    }
    if (explicitApproval || normalized.deploy?.deployApproved) {
      return makeFinding({
        operationType: opType,
        category: 'deploy',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.8,
        decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
        reason: AUTOMATION_SAFETY_REASONS.DEPLOY_REQUIRES_APPROVAL,
        notes: ['Deploy with explicit approval is still a review gate decision.'],
        sensitive: false,
        explicitApproval,
        previewRequested: false,
      });
    }
    return makeFinding({
      operationType: opType,
      category: 'deploy',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.DEPLOY_REQUIRES_APPROVAL,
      notes: ['Deploy without explicit approval is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, RELEASE_HINTS)) {
    if (normalized.previewRequested || normalized.release?.preview || normalized.release?.dryRun || containsAny(opText, ['release notes preview'])) {
      return makeFinding({
        operationType: opType,
        category: 'release_preview',
        riskLevel: AUTOMATION_RISK_LEVELS.LOW,
        riskScore: 0.15,
        decision: AUTOMATION_SAFETY_DECISIONS.ALLOW,
        reason: AUTOMATION_SAFETY_REASONS.RELEASE_PREVIEW_ONLY,
        notes: ['Release preview or notes preview is read-only.'],
        sensitive: false,
        explicitApproval,
        previewRequested: true,
      });
    }
    if (explicitApproval || normalized.release?.releaseApproved) {
      return makeFinding({
        operationType: opType,
        category: 'release',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.8,
        decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
        reason: AUTOMATION_SAFETY_REASONS.RELEASE_REQUIRES_APPROVAL,
        notes: ['Release with explicit approval remains a review gate decision.'],
        sensitive: false,
        explicitApproval,
        previewRequested: false,
      });
    }
    return makeFinding({
      operationType: opType,
      category: 'release',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.RELEASE_REQUIRES_APPROVAL,
      notes: ['Tag or release without explicit approval is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (containsAny(opText, MERGE_HINTS)) {
    if (normalized.previewRequested) {
      return makeFinding({
        operationType: opType,
        category: 'merge_preview',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.75,
        decision: AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
        reason: AUTOMATION_SAFETY_REASONS.DRY_RUN_ONLY_PREVIEW,
        notes: ['Merge preview can be generated safely, but not executed.'],
        sensitive: false,
        explicitApproval,
        previewRequested: true,
      });
    }

    if (signalsEqual(opType, 'local_merge_push')) {
      if (explicitApproval && approvedMergePath) {
        return makeFinding({
          operationType: opType,
          category: 'local_merge_push',
          riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
          riskScore: 0.8,
          decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
          reason: AUTOMATION_SAFETY_REASONS.LOCAL_MERGE_PUSH_REQUIRES_APPROVAL,
          notes: ['Local merge + push requires explicit approval metadata.'],
          sensitive: false,
          explicitApproval,
          previewRequested: false,
        });
      }
      return makeFinding({
        operationType: opType,
        category: 'local_merge_push',
        riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
        riskScore: 1,
        decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
        reason: AUTOMATION_SAFETY_REASONS.LOCAL_MERGE_PUSH_REQUIRES_APPROVAL,
        notes: ['Local merge + push without explicit approval is blocked.'],
        sensitive: false,
        explicitApproval,
        previewRequested: false,
      });
    }

    if (signalsEqual(opType, 'merge_pr') || containsAny(opText, ['merge pull request'])) {
      if (explicitApproval) {
        return makeFinding({
          operationType: opType,
          category: 'merge_pr',
          riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
          riskScore: 0.8,
          decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
          reason: AUTOMATION_SAFETY_REASONS.MERGE_REQUIRES_APPROVAL,
          notes: ['Merge PR with explicit approval stays on review until executed by a human.'],
          sensitive: false,
          explicitApproval,
          previewRequested: false,
        });
      }
      return makeFinding({
        operationType: opType,
        category: 'merge_pr',
        riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
        riskScore: 1,
        decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
        reason: AUTOMATION_SAFETY_REASONS.MERGE_REQUIRES_APPROVAL,
        notes: ['Merge PR without explicit approval is blocked.'],
        sensitive: false,
        explicitApproval,
        previewRequested: false,
      });
    }
  }

  return null;
}

module.exports = { classifyDeliveryPhase };
