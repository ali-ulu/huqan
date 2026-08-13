'use strict';

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_RISK_LEVELS,
  MEMORY_MUTATION_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  BREADTH_REVIEW_THRESHOLD,
  BREADTH_DRY_RUN_THRESHOLD,
} = require('./memory-mutation-vocabulary');
const {
  isPlainObject,
  firstText,
  containsAny,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  clampScore,
  mergeDecision,
  isSecretLikeValue,
  normalizeMemoryMutationInput,
} = require('./memory-mutation-normalizer');
const { classifyMemoryMutation } = require('./memory-mutation-classifier');
const { normalizeMemoryMutationFinding, summarizeMemoryMutationFindings } = require('./memory-mutation-findings-summary');

function applyPolicyFloor(decision, reason, policy) {
  const minimumDecision = normalizeDecisionLabel(policy && policy.minimumDecision);
  if (!minimumDecision) {
    return { decision, reason };
  }

  const raised = mergeDecision(decision, minimumDecision);
  if (raised !== decision) {
    return {
      decision: raised,
      reason: raised === MEMORY_MUTATION_GATE_DECISIONS.BLOCK
        ? MEMORY_MUTATION_GATE_REASONS.POLICY_OVERRIDE_BLOCK
        : MEMORY_MUTATION_GATE_REASONS.POLICY_OVERRIDE_REVIEW,
    };
  }

  return { decision, reason };
}

function normalizeMemoryMutationDecision(decision) {
  const raw = isPlainObject(decision) ? decision : {};
  const normalizedDecision = normalizeDecisionLabel(raw.decision);
  const normalizedRisk = isPlainObject(raw.risk) ? raw.risk : {};
  const normalizedFindings = Array.isArray(raw.findings)
    ? raw.findings.map(normalizeMemoryMutationFinding).sort((left, right) => `${left.workspaceId}:${left.id}`.localeCompare(`${right.workspaceId}:${right.id}`))
    : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean).map(value => String(value)) : [];
  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};

  return {
    ok: Boolean(raw.ok ?? true),
    allowed: normalizedDecision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
    canApply: normalizedDecision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
    canDryRun: normalizedDecision !== MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
    decision: normalizedDecision || MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
    reason: firstText(raw.reason, MEMORY_MUTATION_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED),
    risk: {
      level: normalizeRiskLevel(normalizedRisk.level),
      score: clampScore(normalizedRisk.score, 0.5),
      categories: Array.isArray(normalizedRisk.categories)
        ? [...new Set(normalizedRisk.categories.filter(Boolean).map(value => String(value)))].sort()
        : [],
    },
    requiredReview: normalizedDecision !== MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
    dryRunOnly: normalizedDecision === MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY,
    findings: normalizedFindings,
    warnings,
    metadata: {
      policyVersion: firstText(metadata.policyVersion, MEMORY_MUTATION_POLICY_VERSION),
      workspaceId: firstText(metadata.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    },
  };
}

function evaluateMemoryMutation(input, options = {}) {
  const normalized = normalizeMemoryMutationInput({
    ...(isPlainObject(input) ? input : {}),
    policyOverride: options.policy || (isPlainObject(input) ? input.policyOverride : null),
  });

  const findings = normalized.entries.map(entry => classifyMemoryMutation(entry, normalized));
  const summary = summarizeMemoryMutationFindings(findings);
  const warnings = [];
  let decision = summary.decision;
  let reason = summary.reason;
  let riskLevel = summary.riskLevel;
  let riskScore = summary.riskScore;

  const secretDetected = isSecretLikeValue({
    operationType: normalized.operationType,
    mutationType: normalized.mutationType,
    targetSpace: normalized.targetSpace,
    diffSummary: normalized.diffSummary,
    mutationMetadata: isPlainObject(normalized.raw.mutationMetadata) ? normalized.raw.mutationMetadata : normalized.mutationMetadata,
    metadata: isPlainObject(normalized.raw.metadata) ? normalized.raw.metadata : normalized.metadata,
    entries: normalized.entries,
  });

  if (normalized.malformed) {
    decision = mergeDecision(decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    reason = MEMORY_MUTATION_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED;
    warnings.push('Malformed memory mutation input detected.');
  }

  if (!normalized.entries.length) {
    decision = mergeDecision(decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    reason = MEMORY_MUTATION_GATE_REASONS.EMPTY_ENTRY_LIST_REVIEW_REQUIRED;
    warnings.push('No memory entries were provided.');
  }

  if (normalized.operationType === 'unknown') {
    decision = mergeDecision(decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    reason = MEMORY_MUTATION_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED;
    warnings.push('Unknown operation type detected.');
  }

  if (normalized.repoState.dirty || normalized.repoState.hasUntracked) {
    decision = mergeDecision(decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    reason = MEMORY_MUTATION_GATE_REASONS.DIRTY_REPO_REVIEW_REQUIRED;
    warnings.push('Dirty root or untracked files detected.');
  }

  if (normalized.repoState.isMain && containsAny(normalized.operationType, ['write', 'patch', 'update', 'apply', 'commit', 'store', 'save', 'import', 'sync'])) {
    decision = MEMORY_MUTATION_GATE_DECISIONS.BLOCK;
    reason = MEMORY_MUTATION_GATE_REASONS.MAIN_BRANCH_WRITE_BLOCKED;
    warnings.push('Write attempt on main branch blocked.');
  }

  if (secretDetected) {
    decision = MEMORY_MUTATION_GATE_DECISIONS.BLOCK;
    reason = MEMORY_MUTATION_GATE_REASONS.SECRET_MUTATION_BLOCKED;
    warnings.push('Sensitive token-like memory content detected.');
  }

  const entryCount = normalized.mutationMetadata.entryCount || normalized.entries.length;
  const graphCount = normalized.mutationMetadata.graphCount || 0;
  const linkCount = normalized.mutationMetadata.linkCount || 0;
  const workspaceCount = normalized.mutationMetadata.workspaceCount || 0;
  const crossWorkspaceCount = normalized.mutationMetadata.crossWorkspaceCount || 0;

  if (workspaceCount > 1 || crossWorkspaceCount > 0) {
    decision = MEMORY_MUTATION_GATE_DECISIONS.BLOCK;
    reason = MEMORY_MUTATION_GATE_REASONS.CROSS_WORKSPACE_MUTATION_BLOCKED;
    warnings.push('Cross-workspace mutation detected.');
  }

  if (entryCount >= BREADTH_REVIEW_THRESHOLD && (graphCount > 0 || linkCount > 0 || summary.categories.some(category => !['read_only', 'metadata'].includes(category)))) {
    const breadthDecision = entryCount >= BREADTH_DRY_RUN_THRESHOLD
      ? MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY
      : MEMORY_MUTATION_GATE_DECISIONS.REVIEW;
    if (decision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW) {
      decision = breadthDecision;
      reason = MEMORY_MUTATION_GATE_REASONS.BREADTH_REVIEW_REQUIRED;
    } else {
      decision = mergeDecision(decision, breadthDecision);
    }
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
    warnings.push('Broad memory mutation spans many entries.');
  }

  if (summary.categories.some(category => ['graph', 'package_import', 'content'].includes(category)) && decision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW) {
    decision = MEMORY_MUTATION_GATE_DECISIONS.REVIEW;
    reason = MEMORY_MUTATION_GATE_REASONS.CROSS_CUTTING_CHANGE_REVIEW_REQUIRED;
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.MEDIUM;
    riskScore = Math.max(riskScore, 0.55);
  }

  const policyApplied = applyPolicyFloor(decision, reason, normalized.policy);
  decision = policyApplied.decision;
  reason = policyApplied.reason;

  if (decision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW) {
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.LOW;
    riskScore = Math.min(riskScore, 0.2);
  } else if (decision === MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY) {
    riskLevel = riskLevel === MEMORY_MUTATION_RISK_LEVELS.CRITICAL ? MEMORY_MUTATION_RISK_LEVELS.CRITICAL : MEMORY_MUTATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
  } else if (decision === MEMORY_MUTATION_GATE_DECISIONS.REVIEW) {
    riskLevel = riskLevel === MEMORY_MUTATION_RISK_LEVELS.CRITICAL ? MEMORY_MUTATION_RISK_LEVELS.CRITICAL : (riskLevel === MEMORY_MUTATION_RISK_LEVELS.HIGH ? MEMORY_MUTATION_RISK_LEVELS.HIGH : MEMORY_MUTATION_RISK_LEVELS.MEDIUM);
    riskScore = Math.max(riskScore, 0.55);
  } else {
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.CRITICAL;
    riskScore = 1;
  }

  const result = {
    ok: true,
    allowed: decision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
    canApply: decision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
    canDryRun: decision !== MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
    decision,
    reason,
    risk: {
      level: riskLevel,
      score: clampScore(riskScore, 0.5),
      categories: summary.categories,
    },
    requiredReview: decision !== MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
    dryRunOnly: decision === MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY,
    findings,
    warnings,
    metadata: {
      policyVersion: normalized.policy.policyVersion || MEMORY_MUTATION_POLICY_VERSION,
      workspaceId: normalized.metadata.workspaceId || DEFAULT_WORKSPACE_ID,
    },
  };

  return normalizeMemoryMutationDecision(result);
}

module.exports = {
  applyPolicyFloor,
  normalizeMemoryMutationDecision,
  evaluateMemoryMutation,
};
