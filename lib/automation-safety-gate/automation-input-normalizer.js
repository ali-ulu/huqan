'use strict';

const { normalizeText } = require('../text-utils');
const {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_RISK_LEVELS,
  AUTOMATION_SAFETY_POLICY_VERSION,
  AUTOMATION_SAFETY_REASONS,
  DEFAULT_WORKSPACE_ID,
  PREVIEW_HINTS,
  SECRET_HINTS,
} = require('./automation-safety-vocabulary');

const { isPlainObject } = require('../is-plain-object');

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
  // Whole-word/whole-phrase match, not substring: a naive .includes() let
  // 'read' match inside 'already merged' or 'bread crumbs', and 'check'
  // match inside 'checkout', silently downgrading a mutating operation to
  // ALLOW (#450). Every hint is matched as a contiguous run of whole words.
  const textWords = normalizeSignal(text).split(' ').filter(Boolean);
  return tokens.some(token => {
    const tokenWords = normalizeSignal(token).split(' ').filter(Boolean);
    if (tokenWords.length === 0) return false;
    for (let start = 0; start + tokenWords.length <= textWords.length; start++) {
      let matches = true;
      for (let offset = 0; offset < tokenWords.length; offset++) {
        if (textWords[start + offset] !== tokenWords[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
    return false;
  });
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

module.exports = {
  isPlainObject,
  firstText,
  normalizeSignal,
  containsAny,
  signalsEqual,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  clampScore,
  decisionRank,
  decisionFromRank,
  mergeDecision,
  isSecretLikeValue,
  normalizePolicy,
  normalizeRepoState,
  normalizeApproval,
  normalizeAutomationSafetyInput,
  makeFinding,
};
