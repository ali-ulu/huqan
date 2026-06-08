'use strict';

const { normalizeText } = require('./text-utils');

const AUTOMATION_SAFETY_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
  DRY_RUN_ONLY: 'dry_run_only',
});

const AUTOMATION_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const AUTOMATION_SAFETY_REASONS = Object.freeze({
  LOW_RISK_READ_ONLY: 'LOW_RISK_READ_ONLY',
  LOW_RISK_CI_INSPECTION: 'LOW_RISK_CI_INSPECTION',
  DRY_RUN_ONLY_PREVIEW: 'DRY_RUN_ONLY_PREVIEW',
  REPOSITORY_MUTATION_REVIEW_REQUIRED: 'REPOSITORY_MUTATION_REVIEW_REQUIRED',
  MERGE_REQUIRES_APPROVAL: 'MERGE_REQUIRES_APPROVAL',
  LOCAL_MERGE_PUSH_REQUIRES_APPROVAL: 'LOCAL_MERGE_PUSH_REQUIRES_APPROVAL',
  DEPLOY_REQUIRES_APPROVAL: 'DEPLOY_REQUIRES_APPROVAL',
  DEPLOY_PREVIEW_ONLY: 'DEPLOY_PREVIEW_ONLY',
  RELEASE_REQUIRES_APPROVAL: 'RELEASE_REQUIRES_APPROVAL',
  RELEASE_PREVIEW_ONLY: 'RELEASE_PREVIEW_ONLY',
  AUTO_MERGE_BLOCKED: 'AUTO_MERGE_BLOCKED',
  ENABLE_AUTO_MERGE_BLOCKED: 'ENABLE_AUTO_MERGE_BLOCKED',
  FORCE_PUSH_BLOCKED: 'FORCE_PUSH_BLOCKED',
  HISTORY_REWRITE_BLOCKED: 'HISTORY_REWRITE_BLOCKED',
  BRANCH_PROTECTION_BYPASS_BLOCKED: 'BRANCH_PROTECTION_BYPASS_BLOCKED',
  CI_BYPASS_BLOCKED: 'CI_BYPASS_BLOCKED',
  WORKFLOW_ABUSE_BLOCKED: 'WORKFLOW_ABUSE_BLOCKED',
  WORKFLOW_DISPATCH_REVIEW_REQUIRED: 'WORKFLOW_DISPATCH_REVIEW_REQUIRED',
  DESTRUCTIVE_CLEANUP_BLOCKED: 'DESTRUCTIVE_CLEANUP_BLOCKED',
  TOKEN_PERSISTENCE_BLOCKED: 'TOKEN_PERSISTENCE_BLOCKED',
  PUSH_TO_MAIN_BLOCKED: 'PUSH_TO_MAIN_BLOCKED',
  BRANCH_DELETE_REVIEW_REQUIRED: 'BRANCH_DELETE_REVIEW_REQUIRED',
  REPO_SETTINGS_CHANGE_REVIEW_REQUIRED: 'REPO_SETTINGS_CHANGE_REVIEW_REQUIRED',
  REPOSITORY_MUTATION_REVIEW_REQUIRED: 'REPOSITORY_MUTATION_REVIEW_REQUIRED',
  UNKNOWN_OPERATION_REVIEW_REQUIRED: 'UNKNOWN_OPERATION_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  DIRTY_REPO_REVIEW_REQUIRED: 'DIRTY_REPO_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
});

const AUTOMATION_SAFETY_POLICY_VERSION = 'AB5-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';

const READ_ONLY_HINTS = Object.freeze([
  'read',
  'status',
  'check',
  'inspect',
  'inspect',
  'ci inspection',
  'ci status',
  'read only',
  'read-only',
  'dry run report',
  'report',
  'view',
  'show',
  'list',
  'query',
  'search',
]);

const DEPLOY_HINTS = Object.freeze(['deploy']);
const RELEASE_HINTS = Object.freeze(['release', 'tag_release', 'create_release']);
const MERGE_HINTS = Object.freeze(['merge_pr', 'local_merge_push', 'merge pull request', 'merge']);
const AUTO_MERGE_HINTS = Object.freeze(['enable_auto_merge', 'auto_merge', 'auto-merge', 'automerge']);
const FORCE_PUSH_HINTS = Object.freeze(['force_push', 'force-push']);
const HISTORY_REWRITE_HINTS = Object.freeze(['history_rewrite', 'rewrite_history', 'history rewrite', 'rebase', 'reset_hard']);
const BRANCH_PROTECTION_HINTS = Object.freeze(['branch_protection_change', 'branch protection', 'ruleset', 'protection bypass']);
const CI_BYPASS_HINTS = Object.freeze(['ci_bypass', 'skip ci', 'skip_ci', 'bypass ci', 'ci bypass']);
const WORKFLOW_HINTS = Object.freeze(['workflow_change', 'workflow_dispatch', 'workflow abuse', 'workflow_abuse']);
const DESTRUCTIVE_HINTS = Object.freeze(['destructive_cleanup', 'cleanup', 'prune', 'destroy', 'wipe', 'purge']);
const TOKEN_PERSISTENCE_HINTS = Object.freeze(['token_persistence', 'secret_persistence', 'persist token', 'save token', 'store token']);
const BRANCH_DELETE_HINTS = Object.freeze(['branch_delete', 'delete branch']);
const SETTINGS_CHANGE_HINTS = Object.freeze(['repo_settings_change', 'repo settings', 'settings change']);
const PUSH_TO_MAIN_HINTS = Object.freeze(['push_to_main', 'push to main', 'main push']);
const PREVIEW_HINTS = Object.freeze(['preview', 'dry run', 'dry-run', 'plan']);
const SECRET_HINTS = Object.freeze([
  'api key',
  'apikey',
  'api_key',
  'api-key',
  'token',
  'secret',
  'password',
  'passwd',
  'bearer',
  'credential',
  'private key',
  '.env',
  'id_rsa',
  'client secret',
]);

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeSignal(value) {
  return normalizeText(String(value ?? '').replace(/[_-]+/g, ' '));
}

function containsAny(text, tokens) {
  const normalized = normalizeSignal(text);
  return tokens.some(token => normalized.includes(normalizeSignal(token)));
}

function signalsEqual(left, right) {
  return normalizeSignal(left) === normalizeSignal(right);
}

function normalizeDecisionLabel(value) {
  const text = normalizeText(value);
  if (text === AUTOMATION_SAFETY_DECISIONS.ALLOW) return AUTOMATION_SAFETY_DECISIONS.ALLOW;
  if (text === AUTOMATION_SAFETY_DECISIONS.REVIEW) return AUTOMATION_SAFETY_DECISIONS.REVIEW;
  if (text === AUTOMATION_SAFETY_DECISIONS.BLOCK) return AUTOMATION_SAFETY_DECISIONS.BLOCK;
  if (text === AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY) return AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY;
  return '';
}

function normalizeRiskLevel(value) {
  const text = normalizeText(value);
  if (text === 'low' || text === 'minimal') return AUTOMATION_RISK_LEVELS.LOW;
  if (text === 'medium' || text === 'moderate') return AUTOMATION_RISK_LEVELS.MEDIUM;
  if (text === 'high') return AUTOMATION_RISK_LEVELS.HIGH;
  if (text === 'critical' || text === 'severe') return AUTOMATION_RISK_LEVELS.CRITICAL;
  return AUTOMATION_RISK_LEVELS.MEDIUM;
}

function clampScore(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function decisionRank(decision) {
  const normalized = normalizeDecisionLabel(decision);
  if (normalized === AUTOMATION_SAFETY_DECISIONS.ALLOW) return 0;
  if (normalized === AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY) return 1;
  if (normalized === AUTOMATION_SAFETY_DECISIONS.REVIEW) return 2;
  if (normalized === AUTOMATION_SAFETY_DECISIONS.BLOCK) return 3;
  return 2;
}

function decisionFromRank(rank) {
  if (rank <= 0) return AUTOMATION_SAFETY_DECISIONS.ALLOW;
  if (rank === 1) return AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY;
  if (rank === 2) return AUTOMATION_SAFETY_DECISIONS.REVIEW;
  return AUTOMATION_SAFETY_DECISIONS.BLOCK;
}

function mergeDecision(current, requested) {
  return decisionFromRank(Math.max(decisionRank(current), decisionRank(requested)));
}

function isSecretLikeValue(value, keyPath = []) {
  const keyText = normalizeText(keyPath[keyPath.length - 1] || '');
  if (containsAny(keyText, SECRET_HINTS)) {
    return true;
  }

  if (typeof value === 'string') {
    const text = String(value).trim();
    if (containsAny(text, SECRET_HINTS)) return true;
    if (/^sk-[a-z0-9]{10,}$/i.test(text)) return true;
    if (/^bearer\s+[a-z0-9._\-+/=]{10,}$/i.test(text)) return true;
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item, index) => isSecretLikeValue(item, keyPath.concat(String(index))));
  }

  if (!isPlainObject(value)) return false;

  return Object.entries(value).some(([key, nested]) => isSecretLikeValue(nested, keyPath.concat(key)));
}

function normalizePolicy(policy) {
  if (!isPlainObject(policy)) {
    return {
      policyVersion: AUTOMATION_SAFETY_POLICY_VERSION,
      minimumDecision: '',
      workspaceId: DEFAULT_WORKSPACE_ID,
    };
  }

  const overrides = isPlainObject(policy.overrides) ? policy.overrides : {};
  const minimumDecision = normalizeDecisionLabel(firstText(
    policy.minimumDecision,
    policy.decision,
    overrides.minimumDecision,
    overrides.decision
  ));

  return {
    ...policy,
    policyVersion: firstText(policy.policyVersion, policy.version, AUTOMATION_SAFETY_POLICY_VERSION),
    minimumDecision,
    workspaceId: firstText(policy.workspaceId, policy.metadata && policy.metadata.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
  };
}

function normalizeRepoState(repoState) {
  const raw = isPlainObject(repoState) ? repoState : {};
  const branch = firstText(raw.branch, raw.currentBranch, '');
  const baseBranch = firstText(raw.baseBranch, raw.targetBranch, '');
  const normalizedBranch = normalizeText(branch);
  const normalizedBase = normalizeText(baseBranch);
  return {
    branch,
    baseBranch,
    isMain: Boolean(raw.isMain ?? (normalizedBranch === 'main' || normalizedBranch.endsWith('/main'))),
    dirty: Boolean(raw.dirty),
    hasUntracked: Boolean(raw.hasUntracked),
    protected: Boolean(raw.protected),
    baseIsMain: Boolean(raw.baseIsMain ?? (normalizedBase === 'main' || normalizedBase.endsWith('/main'))),
  };
}

function normalizeApproval(approval) {
  const raw = isPlainObject(approval) ? approval : {};
  const explicit = Boolean(
    raw.explicit ??
    raw.approved ??
    raw.confirmed ??
    raw.human ??
    raw.reviewed ??
    raw.signoff ??
    raw.humanApproved ??
    raw.explicitApproval
  );
  return {
    raw,
    hasData: isPlainObject(approval) || Boolean(String(approval ?? '').trim()),
    explicit,
    approved: Boolean(raw.approved ?? raw.confirmed ?? raw.humanApproved ?? raw.explicitApproval),
    reviewed: Boolean(raw.reviewed ?? raw.reviewedBy),
    mergeApproved: Boolean(raw.mergeApproved ?? raw.approvedMergePath ?? raw.allowLocalMergePush ?? raw.localMergePushApproved),
    deployApproved: Boolean(raw.deployApproved ?? raw.allowDeploy ?? raw.deployOk),
    releaseApproved: Boolean(raw.releaseApproved ?? raw.allowRelease ?? raw.releaseOk),
    reviewer: firstText(raw.reviewedBy, raw.approvedBy, ''),
    notes: firstText(raw.notes, raw.reason, ''),
  };
}

function normalizeAutomationSafetyInput(input) {
  const raw = isPlainObject(input) ? input : {};
  const operationObject = isPlainObject(raw.operation) ? raw.operation : {};
  const repoState = normalizeRepoState(raw.repoState);
  const policy = normalizePolicy(raw.policyOverride || raw.policy || raw.automationPolicy || raw.gatePolicy);
  const approval = normalizeApproval(raw.approval);
  const ci = isPlainObject(raw.ci) ? raw.ci : {};
  const release = isPlainObject(raw.release) ? raw.release : {};
  const deploy = isPlainObject(raw.deploy) ? raw.deploy : {};
  const github = isPlainObject(raw.github) ? raw.github : {};
  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};
  const target = isPlainObject(raw.target) ? raw.target : {};

  const operationType = normalizeSignal(firstText(
    raw.operationType,
    operationObject.operationType,
    operationObject.type,
    operationObject.kind,
    operationObject.action,
    operationObject.name,
    operationObject.intent,
    raw.operation,
    'unknown'
  ));

  const targetText = firstText(
    raw.target,
    target.name,
    target.repo,
    target.resource,
    target.environment,
    target.branch,
    target.url,
    ''
  );

  const branch = firstText(raw.branch, repoState.branch, target.branch, operationObject.branch, '');
  const baseBranch = firstText(raw.baseBranch, repoState.baseBranch, operationObject.baseBranch, target.baseBranch, '');
  const actor = firstText(raw.actor, operationObject.actor, metadata.actor, approval.reviewer, '');
  const previewRequested = Boolean(
    raw.preview ||
    operationObject.preview ||
    ci.preview ||
    deploy.preview ||
    deploy.dryRun ||
    release.preview ||
    release.dryRun ||
    containsAny(operationType, PREVIEW_HINTS) ||
    containsAny(firstText(targetText, branch, baseBranch, actor), PREVIEW_HINTS)
  );

  const dryRunRequested = Boolean(
    raw.dryRun ||
    raw.dry_run ||
    operationObject.dryRun ||
    ci.dryRun ||
    deploy.dryRun ||
    release.dryRun
  );

  const workspaceId = firstText(raw.metadata && raw.metadata.workspaceId, raw.workspaceId, metadata.workspaceId, policy.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID;
  const malformed = Boolean(raw.__sourceMalformed) || !isPlainObject(input);

  return {
    raw,
    operation: operationObject,
    operationType,
    target: targetText,
    actor,
    branch,
    baseBranch,
    repoState,
    approval,
    ci,
    release,
    deploy,
    github,
    token: firstText(raw.token, operationObject.token, ''),
    priorDecisions: isPlainObject(raw.priorDecisions) ? raw.priorDecisions : {},
    policy,
    metadata: {
      workspaceId,
    },
    previewRequested,
    dryRunRequested,
    malformed,
  };
}

function makeFinding(overrides = {}) {
  return {
    ok: Boolean(overrides.ok ?? true),
    id: firstText(overrides.id, overrides.operationType, 'automation'),
    operationType: normalizeText(firstText(overrides.operationType, '')),
    target: firstText(overrides.target, ''),
    actor: firstText(overrides.actor, ''),
    branch: firstText(overrides.branch, ''),
    baseBranch: firstText(overrides.baseBranch, ''),
    category: firstText(overrides.category, 'unknown'),
    riskLevel: normalizeRiskLevel(overrides.riskLevel),
    riskScore: clampScore(overrides.riskScore, 0.5),
    decision: normalizeDecisionLabel(overrides.decision) || AUTOMATION_SAFETY_DECISIONS.REVIEW,
    reason: firstText(overrides.reason, AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED),
    notes: Array.isArray(overrides.notes) ? overrides.notes.filter(Boolean).map(value => String(value)) : [],
    sensitive: Boolean(overrides.sensitive),
    explicitApproval: Boolean(overrides.explicitApproval),
    previewRequested: Boolean(overrides.previewRequested),
  };
}

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

function summarizeAutomationFindings(findings) {
  const normalizedFindings = Array.isArray(findings)
    ? findings.map(finding => normalizeAutomationFinding(finding)).sort((left, right) => `${left.category}:${left.operationType}:${left.id}`.localeCompare(`${right.category}:${right.operationType}:${right.id}`))
    : [];

  if (!normalizedFindings.length) {
    return {
      entryCount: 0,
      categories: [],
      riskLevel: AUTOMATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: AUTOMATION_SAFETY_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED,
      hasCritical: false,
      hasHighRisk: false,
      reasons: [AUTOMATION_SAFETY_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED],
    };
  }

  let decision = AUTOMATION_SAFETY_DECISIONS.ALLOW;
  let reason = AUTOMATION_SAFETY_REASONS.LOW_RISK_READ_ONLY;
  let riskLevel = AUTOMATION_RISK_LEVELS.LOW;
  let riskScore = 0.1;
  const categories = new Set();
  const reasons = [];
  let hasCritical = false;
  let hasHighRisk = false;

  for (const finding of normalizedFindings) {
    categories.add(finding.category);
    reasons.push(finding.reason);
    decision = mergeDecision(decision, finding.decision);

    const rank = decisionRank(finding.decision);
    if (rank >= 3) {
      hasCritical = true;
      riskLevel = AUTOMATION_RISK_LEVELS.CRITICAL;
      riskScore = 1;
      reason = finding.reason;
      continue;
    }
    if (rank === 2) {
      if (riskLevel === AUTOMATION_RISK_LEVELS.LOW) {
        riskLevel = AUTOMATION_RISK_LEVELS.MEDIUM;
        riskScore = Math.max(riskScore, 0.55);
      }
      reason = finding.reason;
    }
    if (rank === 1) {
      hasHighRisk = true;
      riskLevel = AUTOMATION_RISK_LEVELS.HIGH;
      riskScore = Math.max(riskScore, 0.8);
      reason = finding.reason;
    }
    if (rank === 0) {
      reason = finding.reason;
    }
  }

  const categoryList = [...categories].sort();
  if (hasCritical) {
    decision = AUTOMATION_SAFETY_DECISIONS.BLOCK;
    riskLevel = AUTOMATION_RISK_LEVELS.CRITICAL;
    riskScore = 1;
    reason = reasons.find(item => item === AUTOMATION_SAFETY_REASONS.AUTO_MERGE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.ENABLE_AUTO_MERGE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.FORCE_PUSH_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.HISTORY_REWRITE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.BRANCH_PROTECTION_BYPASS_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.CI_BYPASS_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.WORKFLOW_ABUSE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.DESTRUCTIVE_CLEANUP_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.TOKEN_PERSISTENCE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.PUSH_TO_MAIN_BLOCKED)
      || reason;
  } else if (hasHighRisk && decision === AUTOMATION_SAFETY_DECISIONS.ALLOW) {
    decision = AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY;
    riskLevel = AUTOMATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.8);
    reason = AUTOMATION_SAFETY_REASONS.DRY_RUN_ONLY_PREVIEW;
  } else if (hasHighRisk && decision === AUTOMATION_SAFETY_DECISIONS.REVIEW) {
    riskLevel = AUTOMATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.8);
  } else if (decision === AUTOMATION_SAFETY_DECISIONS.REVIEW) {
    riskLevel = riskLevel === AUTOMATION_RISK_LEVELS.LOW ? AUTOMATION_RISK_LEVELS.MEDIUM : riskLevel;
    riskScore = Math.max(riskScore, 0.55);
  }

  return {
    entryCount: normalizedFindings.length,
    categories: categoryList,
    riskLevel,
    riskScore,
    decision,
    reason,
    hasCritical,
    hasHighRisk,
    reasons,
  };
}

function normalizeAutomationFinding(finding) {
  const raw = isPlainObject(finding) ? finding : {};
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(Boolean).map(value => String(value)) : [];
  return {
    ok: Boolean(raw.ok ?? true),
    id: firstText(raw.id, raw.operationType, 'automation'),
    operationType: normalizeText(firstText(raw.operationType, 'unknown')),
    target: firstText(raw.target, ''),
    actor: firstText(raw.actor, ''),
    branch: firstText(raw.branch, ''),
    baseBranch: firstText(raw.baseBranch, ''),
    category: firstText(raw.category, 'unknown'),
    riskLevel: normalizeRiskLevel(raw.riskLevel),
    riskScore: clampScore(raw.riskScore, 0.5),
    decision: normalizeDecisionLabel(raw.decision) || AUTOMATION_SAFETY_DECISIONS.REVIEW,
    reason: firstText(raw.reason, AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED),
    notes,
    sensitive: Boolean(raw.sensitive),
    explicitApproval: Boolean(raw.explicitApproval),
    previewRequested: Boolean(raw.previewRequested),
  };
}

function applyPolicyFloor(decision, reason, policy) {
  const minimumDecision = normalizeDecisionLabel(policy && policy.minimumDecision);
  if (!minimumDecision) {
    return { decision, reason };
  }

  const raised = mergeDecision(decision, minimumDecision);
  if (raised !== decision) {
    return {
      decision: raised,
      reason: raised === AUTOMATION_SAFETY_DECISIONS.BLOCK
        ? AUTOMATION_SAFETY_REASONS.POLICY_OVERRIDE_BLOCK
        : AUTOMATION_SAFETY_REASONS.POLICY_OVERRIDE_REVIEW,
    };
  }

  return { decision, reason };
}

function normalizeAutomationSafetyDecision(decision) {
  const raw = isPlainObject(decision) ? decision : {};
  const normalizedDecision = normalizeDecisionLabel(raw.decision);
  const normalizedRisk = isPlainObject(raw.risk) ? raw.risk : {};
  const normalizedFindings = Array.isArray(raw.findings)
    ? raw.findings.map(finding => normalizeAutomationFinding(finding)).sort((left, right) => `${left.category}:${left.operationType}:${left.id}`.localeCompare(`${right.category}:${right.operationType}:${right.id}`))
    : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean).map(value => String(value)) : [];
  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};

  return {
    ok: Boolean(raw.ok ?? true),
    allowed: normalizedDecision === AUTOMATION_SAFETY_DECISIONS.ALLOW,
    canExecute: normalizedDecision === AUTOMATION_SAFETY_DECISIONS.ALLOW,
    canDryRun: normalizedDecision !== AUTOMATION_SAFETY_DECISIONS.BLOCK,
    decision: normalizedDecision || AUTOMATION_SAFETY_DECISIONS.REVIEW,
    reason: firstText(raw.reason, AUTOMATION_SAFETY_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED),
    risk: {
      level: normalizeRiskLevel(normalizedRisk.level),
      score: clampScore(normalizedRisk.score, 0.5),
      categories: Array.isArray(normalizedRisk.categories)
        ? [...new Set(normalizedRisk.categories.filter(Boolean).map(value => String(value)))].sort()
        : [],
    },
    requiredReview: normalizedDecision !== AUTOMATION_SAFETY_DECISIONS.ALLOW,
    dryRunOnly: normalizedDecision === AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
    findings: normalizedFindings,
    warnings,
    metadata: {
      policyVersion: firstText(metadata.policyVersion, AUTOMATION_SAFETY_POLICY_VERSION),
      workspaceId: firstText(metadata.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    },
  };
}

function evaluateAutomationSafety(input, options = {}) {
  const normalized = normalizeAutomationSafetyInput({
    ...(isPlainObject(input) ? input : {}),
    __sourceMalformed: !isPlainObject(input),
    policyOverride: options.policy || (isPlainObject(input) ? input.policyOverride : null),
  });

  const finding = classifyAutomationOperation(normalized);
  const warnings = [];
  let decision = finding.decision;
  let reason = finding.reason;
  let riskLevel = finding.riskLevel;
  let riskScore = finding.riskScore;
  const secretDetected = isSecretLikeValue({
    operationType: normalized.operationType,
    operation: normalized.raw.operation,
    target: normalized.target,
    actor: normalized.actor,
    branch: normalized.branch,
    baseBranch: normalized.baseBranch,
    repoState: normalized.repoState,
    approval: normalized.approval ? normalized.approval.raw : undefined,
    ci: normalized.raw.ci,
    release: normalized.raw.release,
    deploy: normalized.raw.deploy,
    github: normalized.raw.github,
    metadata: normalized.raw.metadata,
  });

  if (normalized.malformed) {
    decision = mergeDecision(decision, AUTOMATION_SAFETY_DECISIONS.REVIEW);
    reason = AUTOMATION_SAFETY_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED;
    warnings.push('Malformed automation input detected.');
  }

  if (secretDetected || finding.sensitive) {
    warnings.push('Sensitive automation data detected.');
    if (decision === AUTOMATION_SAFETY_DECISIONS.ALLOW) {
      decision = AUTOMATION_SAFETY_DECISIONS.REVIEW;
      reason = AUTOMATION_SAFETY_REASONS.REPOSITORY_MUTATION_REVIEW_REQUIRED;
    }
  }

  if (normalized.repoState.dirty || normalized.repoState.hasUntracked) {
    if (decision === AUTOMATION_SAFETY_DECISIONS.ALLOW) {
      decision = AUTOMATION_SAFETY_DECISIONS.REVIEW;
      reason = AUTOMATION_SAFETY_REASONS.DIRTY_REPO_REVIEW_REQUIRED;
    }
    warnings.push('Dirty repository state detected.');
  }

  const policyApplied = applyPolicyFloor(decision, reason, normalized.policy);
  decision = policyApplied.decision;
  reason = policyApplied.reason;

  if (decision === AUTOMATION_SAFETY_DECISIONS.ALLOW) {
    riskLevel = AUTOMATION_RISK_LEVELS.LOW;
    riskScore = Math.min(riskScore, 0.2);
  } else if (decision === AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY) {
    riskLevel = riskLevel === AUTOMATION_RISK_LEVELS.CRITICAL ? AUTOMATION_RISK_LEVELS.CRITICAL : AUTOMATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.8);
  } else if (decision === AUTOMATION_SAFETY_DECISIONS.REVIEW) {
    riskLevel = riskLevel === AUTOMATION_RISK_LEVELS.CRITICAL ? AUTOMATION_RISK_LEVELS.CRITICAL : (riskLevel === AUTOMATION_RISK_LEVELS.HIGH ? AUTOMATION_RISK_LEVELS.HIGH : AUTOMATION_RISK_LEVELS.MEDIUM);
    riskScore = Math.max(riskScore, 0.55);
  } else {
    riskLevel = AUTOMATION_RISK_LEVELS.CRITICAL;
    riskScore = 1;
  }

  const result = {
    ok: true,
    allowed: decision === AUTOMATION_SAFETY_DECISIONS.ALLOW,
    canExecute: decision === AUTOMATION_SAFETY_DECISIONS.ALLOW,
    canDryRun: decision !== AUTOMATION_SAFETY_DECISIONS.BLOCK,
    decision,
    reason,
    risk: {
      level: riskLevel,
      score: clampScore(riskScore, 0.5),
      categories: summarizeAutomationFindings([finding]).categories,
    },
    requiredReview: decision !== AUTOMATION_SAFETY_DECISIONS.ALLOW,
    dryRunOnly: decision === AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
    findings: [finding],
    warnings,
    metadata: {
      policyVersion: normalized.policy.policyVersion || AUTOMATION_SAFETY_POLICY_VERSION,
      workspaceId: normalized.metadata.workspaceId || DEFAULT_WORKSPACE_ID,
    },
  };

  return normalizeAutomationSafetyDecision(result);
}

module.exports = {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_SAFETY_REASONS,
  AUTOMATION_RISK_LEVELS,
  AUTOMATION_SAFETY_POLICY_VERSION,
  evaluateAutomationSafety,
  normalizeAutomationSafetyInput,
  normalizeAutomationSafetyDecision,
  classifyAutomationOperation,
  summarizeAutomationFindings,
};
