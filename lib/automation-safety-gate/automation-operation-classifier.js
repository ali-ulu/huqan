'use strict';

const { AUTOMATION_SAFETY_DECISIONS, AUTOMATION_RISK_LEVELS, AUTOMATION_SAFETY_REASONS } = require('./automation-safety-vocabulary');
const {
  READ_ONLY_HINTS,
  DEPLOY_HINTS,
  RELEASE_HINTS,
  MERGE_HINTS,
  AUTO_MERGE_HINTS,
  FORCE_PUSH_HINTS,
  HISTORY_REWRITE_HINTS,
  BRANCH_PROTECTION_HINTS,
  CI_BYPASS_HINTS,
  WORKFLOW_HINTS,
  DESTRUCTIVE_HINTS,
  TOKEN_PERSISTENCE_HINTS,
  BRANCH_DELETE_HINTS,
  SETTINGS_CHANGE_HINTS,
  PUSH_TO_MAIN_HINTS,
  PREVIEW_HINTS,
} = require('./automation-safety-vocabulary');
const { isPlainObject, firstText, containsAny, signalsEqual, isSecretLikeValue, makeFinding } = require('./automation-input-normalizer');
const { normalizeText } = require('../text-utils');

// classifyAutomationOperation is kept as a single function, unlike the
// classifiers in the sibling lib/memory-mutation-gate/ split. Its branches
// are one long ordered if-chain where later checks are deliberately
// unreachable for inputs caught earlier (e.g. CI_BYPASS_HINTS is checked at
// two different points; BRANCH_DELETE_HINTS and SETTINGS_CHANGE_HINTS too),
// and every branch shares local context computed at the top (opType, opText,
// explicitApproval, approvedMergePath, secretDetected). Splitting it into
// smaller functions without re-verifying that ordering rule-by-rule risks
// silently changing which check wins for a given input -- exactly the
// "understand it before you touch it" case. Left as one ~580-line function;
// everything around it (constants, normalizers, summarizer, decision/evaluate)
// is still split out, so the file itself no longer needs to hold all of that
// too.
function classifyAutomationOperation(context = {}) {
  const normalized = isPlainObject(context) ? context : {};
  const opType = normalizeText(firstText(normalized.operationType, 'unknown'));
  const opText = normalizeText([
    opType,
    normalized.target,
    normalized.actor,
    normalized.branch,
    normalized.baseBranch,
    normalized.repoState && normalized.repoState.branch,
    normalized.repoState && normalized.repoState.baseBranch,
  ].filter(Boolean).join(' '));
  const explicitApproval = Boolean(normalized.approval && (normalized.approval.explicit || normalized.approval.approved || normalized.approval.mergeApproved || normalized.approval.deployApproved || normalized.approval.releaseApproved));
  const approvalProvided = Boolean(normalized.approval && normalized.approval.hasData);
  const approvedMergePath = Boolean(normalized.approval && normalized.approval.mergeApproved);
  const repoDirty = Boolean(normalized.repoState && (normalized.repoState.dirty || normalized.repoState.hasUntracked));
  const isMainBranch = Boolean(normalized.repoState && normalized.repoState.isMain);
  const baseIsMain = Boolean(normalized.repoState && normalized.repoState.baseIsMain);
  const secretDetected = isSecretLikeValue({
    operationType: opType,
    operation: normalized.operation,
    target: normalized.target,
    actor: normalized.actor,
    branch: normalized.branch,
    baseBranch: normalized.baseBranch,
    repoState: normalized.repoState,
    approval: normalized.approval ? normalized.approval.raw : undefined,
    ci: normalized.ci,
    release: normalized.release,
    deploy: normalized.deploy,
    github: normalized.github,
    metadata: normalized.metadata,
  });

  if (!opType || opType === 'unknown' || opType === 'undefined' || opType === 'null') {
    return makeFinding({
      operationType: opType || 'unknown',
      category: 'unknown',
      riskLevel: AUTOMATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED,
      notes: ['Operation type could not be safely categorized.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  if (normalized.previewRequested || normalized.dryRunRequested || containsAny(opText, PREVIEW_HINTS)) {
    if (containsAny(opType, ['deploy']) || containsAny(opText, DEPLOY_HINTS)) {
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
    if (containsAny(opType, ['release_notes_preview']) || containsAny(opText, ['release notes preview', 'release-notes-preview'])) {
      return makeFinding({
        operationType: opType,
        category: 'preview',
        riskLevel: AUTOMATION_RISK_LEVELS.LOW,
        riskScore: 0.15,
        decision: AUTOMATION_SAFETY_DECISIONS.ALLOW,
        reason: AUTOMATION_SAFETY_REASONS.RELEASE_PREVIEW_ONLY,
        notes: ['Release notes preview is read-only.'],
        sensitive: false,
        explicitApproval,
        previewRequested: true,
      });
    }
    if (containsAny(opType, ['merge']) || containsAny(opText, MERGE_HINTS) || containsAny(opText, RELEASE_HINTS)) {
      return makeFinding({
        operationType: opType,
        category: 'preview',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.75,
        decision: AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
        reason: AUTOMATION_SAFETY_REASONS.DRY_RUN_ONLY_PREVIEW,
        notes: ['Mutation preview is safe, execution must wait.'],
        sensitive: false,
        explicitApproval,
        previewRequested: true,
      });
    }
  }

  if (containsAny(opText, READ_ONLY_HINTS) && !containsAny(opText, DEPLOY_HINTS) && !containsAny(opText, RELEASE_HINTS) && !containsAny(opText, MERGE_HINTS) && !containsAny(opText, AUTO_MERGE_HINTS) && !containsAny(opText, FORCE_PUSH_HINTS) && !containsAny(opText, HISTORY_REWRITE_HINTS) && !containsAny(opText, BRANCH_PROTECTION_HINTS) && !containsAny(opText, CI_BYPASS_HINTS) && !containsAny(opText, WORKFLOW_HINTS) && !containsAny(opText, DESTRUCTIVE_HINTS) && !containsAny(opText, TOKEN_PERSISTENCE_HINTS) && !containsAny(opText, PUSH_TO_MAIN_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'read_only',
      riskLevel: AUTOMATION_RISK_LEVELS.LOW,
      riskScore: 0.1,
      decision: AUTOMATION_SAFETY_DECISIONS.ALLOW,
      reason: containsAny(opText, ['ci']) ? AUTOMATION_SAFETY_REASONS.LOW_RISK_CI_INSPECTION : AUTOMATION_SAFETY_REASONS.LOW_RISK_READ_ONLY,
      notes: ['Read-only automation inspection.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

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

  if (containsAny(opText, DEPLOY_HINTS)) {
    if (normalized.previewRequested || normalized.deploy.preview || normalized.deploy.dryRun) {
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
    if (explicitApproval || normalized.deploy.deployApproved) {
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
    if (normalized.previewRequested || normalized.release.preview || normalized.release.dryRun || containsAny(opText, ['release notes preview'])) {
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
    if (explicitApproval || normalized.release.releaseApproved) {
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

  if (signalsEqual(opType, 'push_to_main')) {
    if (explicitApproval && approvedMergePath) {
      return makeFinding({
        operationType: opType,
        category: 'push_to_main',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.85,
        decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
        reason: AUTOMATION_SAFETY_REASONS.MERGE_REQUIRES_APPROVAL,
        notes: ['Push to main only follows an approved merge path.'],
        sensitive: false,
        explicitApproval,
        previewRequested: false,
      });
    }
    return makeFinding({
      operationType: opType,
      category: 'push_to_main',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.PUSH_TO_MAIN_BLOCKED,
      notes: ['Push to main without approved merge context is blocked.'],
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
      notes: ['CI bypass is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (secretDetected) {
    return makeFinding({
      operationType: opType,
      category: 'secret',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.TOKEN_PERSISTENCE_BLOCKED,
      notes: ['Sensitive automation data detected.'],
      sensitive: true,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  if (containsAny(opText, ['workflow_change'])) {
    return makeFinding({
      operationType: opType,
      category: 'workflow',
      riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
      riskScore: 0.7,
      decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: AUTOMATION_SAFETY_REASONS.WORKFLOW_DISPATCH_REVIEW_REQUIRED,
      notes: ['Workflow change requires review.'],
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
      notes: ['Branch delete should be reviewed.'],
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

  if (containsAny(opText, PUSH_TO_MAIN_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'push_to_main',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.PUSH_TO_MAIN_BLOCKED,
      notes: ['Push to main without approved merge context is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  const isUnknown = opType === 'unknown' || !opType;
  return makeFinding({
    operationType: opType || 'unknown',
    category: isUnknown ? 'unknown' : 'automation',
    riskLevel: AUTOMATION_RISK_LEVELS.MEDIUM,
    riskScore: 0.55,
    decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
    reason: AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED,
    notes: ['Automation operation could not be safely classified.'],
    sensitive: false,
    explicitApproval,
    previewRequested: normalized.previewRequested,
  });
}

module.exports = {
  classifyAutomationOperation,
};
