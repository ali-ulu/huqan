// The tool-call gate: turns a normalized tool call into allow / review /
// block / dry_run_only under a policy floor. Vocabulary, normalization,
// secret handling and action classification live in tool-call-gate-*.js (#2151).

const { isPlainObject } = require('./is-plain-object');
const { classifyAction } = require('./tool-call-gate-classify');
const { clampScore, firstText, normalizeDecisionLabel, normalizeRiskLevel, normalizeToolCall } = require('./tool-call-gate-normalize');
const { hasSecretLookingValue, redactSecretValues } = require('./tool-call-gate-secrets');
const { AB2_POLICY_VERSION, DEFAULT_WORKSPACE_ID, SECRET_KEY_PATTERNS, TOOL_GATE_DECISIONS, TOOL_GATE_REASONS } = require('./tool-call-gate-vocabulary');

function normalizeDecisionRank(decision) {
  const normalized = normalizeDecisionLabel(decision);
  if (normalized === TOOL_GATE_DECISIONS.ALLOW) return 0;
  if (normalized === TOOL_GATE_DECISIONS.DRY_RUN_ONLY) return 1;
  if (normalized === TOOL_GATE_DECISIONS.REVIEW) return 2;
  if (normalized === TOOL_GATE_DECISIONS.BLOCK) return 3;
  return 2;
}

function decisionFromRank(rank) {
  if (rank <= 0) return TOOL_GATE_DECISIONS.ALLOW;
  if (rank === 1) return TOOL_GATE_DECISIONS.DRY_RUN_ONLY;
  if (rank === 2) return TOOL_GATE_DECISIONS.REVIEW;
  return TOOL_GATE_DECISIONS.BLOCK;
}

function mergeDecision(current, requested) {
  const currentRank = normalizeDecisionRank(current);
  const requestedRank = normalizeDecisionRank(requested);
  return decisionFromRank(Math.max(currentRank, requestedRank));
}

function buildWarnings(normalized, actionClass, secretDetected, malformedClassifier) {
  const warnings = [];

  if (!normalized.action && !normalized.toolName) {
    warnings.push('Action could not be normalized.');
  }

  if (secretDetected) {
    warnings.push('Sensitive arguments detected.');
  }

  if (malformedClassifier) {
    warnings.push('Missing or malformed AB1 classifier output.');
  }

  if (actionClass.decision === TOOL_GATE_DECISIONS.DRY_RUN_ONLY && !normalized.dryRun) {
    warnings.push('Dry-run-only operation requires simulation.');
  }

  return warnings;
}

function applyPolicyFloor(decision, reason, policy, actionClass) {
  const minimumDecision = normalizeDecisionLabel(policy?.minimumDecision || '');
  if (!minimumDecision) {
    return { decision, reason };
  }

  if (actionClass.level === 'critical') {
    return {
      decision: TOOL_GATE_DECISIONS.BLOCK,
      reason: TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED,
    };
  }

  const raised = mergeDecision(decision, minimumDecision);
  if (raised !== decision) {
    const overrideReason = raised === TOOL_GATE_DECISIONS.BLOCK
      ? TOOL_GATE_REASONS.POLICY_OVERRIDE_BLOCK
      : TOOL_GATE_REASONS.POLICY_OVERRIDE_REVIEW;
    return {
      decision: raised,
      reason: overrideReason,
    };
  }

  return { decision, reason };
}

function normalizeGateDecision(decision) {
  const normalizedDecision = normalizeDecisionLabel(decision?.decision);
  const reason = firstText(decision?.reason, TOOL_GATE_REASONS.REVIEW_REQUIRED);
  const risk = isPlainObject(decision?.risk) ? decision.risk : {};
  const metadata = isPlainObject(decision?.metadata) ? decision.metadata : {};
  const warnings = Array.isArray(decision?.warnings) ? decision.warnings.filter(Boolean).map(String) : [];

  return {
    ok: Boolean(decision?.ok ?? true),
    allowed: Boolean(decision?.allowed ?? normalizedDecision === TOOL_GATE_DECISIONS.ALLOW),
    canExecute: Boolean(decision?.canExecute ?? normalizedDecision === TOOL_GATE_DECISIONS.ALLOW),
    canDryRun: Boolean(decision?.canDryRun ?? normalizedDecision !== TOOL_GATE_DECISIONS.BLOCK),
    decision: normalizedDecision || TOOL_GATE_DECISIONS.REVIEW,
    reason,
    risk: {
      level: normalizeRiskLevel(risk.level),
      score: clampScore(risk.score, 0.5),
      category: firstText(risk.category, 'unknown') || 'unknown',
    },
    requiredReview: Boolean(decision?.requiredReview ?? normalizedDecision !== TOOL_GATE_DECISIONS.ALLOW),
    dryRunOnly: Boolean(decision?.dryRunOnly ?? normalizedDecision === TOOL_GATE_DECISIONS.DRY_RUN_ONLY),
    warnings,
    metadata: {
      policyVersion: firstText(metadata.policyVersion, AB2_POLICY_VERSION),
      ...(metadata.classifierVersion ? { classifierVersion: String(metadata.classifierVersion) } : {}),
      workspaceId: firstText(metadata.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    },
  };
}

function evaluateToolCall(input, policyOverride = null) {
  const normalized = normalizeToolCall({
    ...(isPlainObject(input) ? input : {}),
    policy: policyOverride || (isPlainObject(input) ? input.policy : null),
  });
  const actionClass = classifyAction(normalized);
  const classifier = normalized.classifier;
  const classifierMissingOrMalformed = !classifier || !classifier.valid || !classifier.risk;
  const secretDetected = hasSecretLookingValue({
    args: normalized.args,
    input: normalized.raw?.input,
    request: normalized.raw?.request,
    body: normalized.raw?.body,
    payload: normalized.raw?.payload,
  });
  const dryRunRequested = normalized.dryRun;

  let decision = actionClass.decision;
  let reason = actionClass.reason;

  if (classifierMissingOrMalformed && decision === TOOL_GATE_DECISIONS.ALLOW) {
    decision = TOOL_GATE_DECISIONS.REVIEW;
    reason = TOOL_GATE_REASONS.REVIEW_REQUIRED;
  }

  if (secretDetected && decision === TOOL_GATE_DECISIONS.ALLOW) {
    decision = TOOL_GATE_DECISIONS.REVIEW;
    reason = TOOL_GATE_REASONS.SECRET_ARGS_REVIEW_REQUIRED;
  }

  if (dryRunRequested && decision === TOOL_GATE_DECISIONS.ALLOW) {
    decision = TOOL_GATE_DECISIONS.DRY_RUN_ONLY;
    reason = TOOL_GATE_REASONS.DRY_RUN_REQUESTED;
  }

  if (actionClass.level === 'critical') {
    decision = TOOL_GATE_DECISIONS.BLOCK;
    reason = TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED;
  } else if (secretDetected && (decision === TOOL_GATE_DECISIONS.DRY_RUN_ONLY || decision === TOOL_GATE_DECISIONS.REVIEW)) {
    reason = TOOL_GATE_REASONS.SECRET_ARGS_REVIEW_REQUIRED;
  } else if (classifierMissingOrMalformed && decision === TOOL_GATE_DECISIONS.DRY_RUN_ONLY) {
    reason = TOOL_GATE_REASONS.REVIEW_REQUIRED;
  }

  const policyApplied = applyPolicyFloor(decision, reason, normalized.policy, actionClass);
  decision = policyApplied.decision;
  reason = policyApplied.reason;

  if (decision === TOOL_GATE_DECISIONS.ALLOW && classifierMissingOrMalformed) {
    decision = TOOL_GATE_DECISIONS.REVIEW;
    reason = TOOL_GATE_REASONS.REVIEW_REQUIRED;
  }

  const warnings = buildWarnings(normalized, { decision, level: actionClass.level }, secretDetected, classifierMissingOrMalformed);
  const metadata = {
    policyVersion: normalized.policy.policyVersion || AB2_POLICY_VERSION,
    workspaceId: normalized.workspaceId || DEFAULT_WORKSPACE_ID,
    ...(classifier && classifier.classifierVersion
      ? { classifierVersion: classifier.classifierVersion }
      : {}),
  };

  const risk = {
    level: actionClass.level,
    score: actionClass.score,
    category: actionClass.category,
  };

  const result = {
    ok: true,
    allowed: decision === TOOL_GATE_DECISIONS.ALLOW,
    canExecute: decision === TOOL_GATE_DECISIONS.ALLOW,
    canDryRun: decision !== TOOL_GATE_DECISIONS.BLOCK,
    decision,
    reason,
    risk,
    requiredReview: decision !== TOOL_GATE_DECISIONS.ALLOW,
    dryRunOnly: decision === TOOL_GATE_DECISIONS.DRY_RUN_ONLY,
    warnings,
    metadata,
  };

  return normalizeGateDecision(result);
}

module.exports = {
  AB2_POLICY_VERSION,
  TOOL_GATE_DECISIONS,
  TOOL_GATE_REASONS,
  SECRET_KEY_PATTERNS,
  evaluateToolCall,
  normalizeGateDecision,
  normalizeToolCall,
  hasSecretLookingValue,
  redactSecretValues,
};
