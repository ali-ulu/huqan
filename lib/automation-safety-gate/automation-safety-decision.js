'use strict';

const {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_SAFETY_REASONS,
  AUTOMATION_RISK_LEVELS,
  AUTOMATION_SAFETY_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
} = require('./automation-safety-vocabulary');
const {
  isPlainObject,
  firstText,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  clampScore,
  mergeDecision,
  isSecretLikeValue,
  normalizeAutomationSafetyInput,
} = require('./automation-input-normalizer');
const { classifyAutomationOperation } = require('./automation-operation-classifier');
const { normalizeAutomationFinding, summarizeAutomationFindings } = require('./automation-findings-summary');

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
    if (secretDetected) {
      // #402: a detected secret is escalated all the way to BLOCK, not just
      // bumped from ALLOW to REVIEW. mergeDecision is monotonic (never
      // downgrades an already-higher decision), so classifyAutomationOperation
      // returning BLOCK on its own is preserved either way.
      if (decision !== AUTOMATION_SAFETY_DECISIONS.BLOCK) {
        reason = AUTOMATION_SAFETY_REASONS.SECRET_DETECTED_BLOCKED;
      }
      decision = mergeDecision(decision, AUTOMATION_SAFETY_DECISIONS.BLOCK);
    } else if (decision === AUTOMATION_SAFETY_DECISIONS.ALLOW) {
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
  applyPolicyFloor,
  normalizeAutomationSafetyDecision,
  evaluateAutomationSafety,
};
