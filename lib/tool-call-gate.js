const { normalizeText } = require('./text-utils');

const TOOL_GATE_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
  DRY_RUN_ONLY: 'dry_run_only',
});

const TOOL_GATE_REASONS = Object.freeze({
  LOW_RISK_ACTION: 'LOW_RISK_ACTION',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  CRITICAL_MUTATION_BLOCKED: 'CRITICAL_MUTATION_BLOCKED',
  HIGH_RISK_ACTION_DRY_RUN_ONLY: 'HIGH_RISK_ACTION_DRY_RUN_ONLY',
  UNKNOWN_ACTION_REVIEW_REQUIRED: 'UNKNOWN_ACTION_REVIEW_REQUIRED',
  SECRET_ARGS_REVIEW_REQUIRED: 'SECRET_ARGS_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
  EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED: 'EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED',
  DRY_RUN_REQUESTED: 'DRY_RUN_REQUESTED',
});

const AB2_POLICY_VERSION = 'AB2-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';

const READ_ONLY_ACTIONS = Object.freeze([
  'read',
  'get',
  'list',
  'fetch',
  'inspect',
  'view',
  'show',
  'open',
  'query',
  'search',
  'status',
  'describe',
  'check',
  'health',
]);

const WRITE_ACTIONS = Object.freeze([
  'write',
  'update',
  'create',
  'set',
  'edit',
  'patch',
  'save',
  'insert',
  'add',
  'modify',
]);

const DESTRUCTIVE_ACTIONS = Object.freeze([
  'delete',
  'remove',
  'destroy',
  'drop',
  'purge',
  'wipe',
  'truncate',
  'format',
  'reset',
  'erase',
  'revoke',
  'kill',
  'shutdown',
]);

const DEPLOY_ACTIONS = Object.freeze([
  'deploy',
  'publish',
  'release',
  'ship',
  'promote',
  'push',
  'upload',
]);

const SIDE_EFFECT_ACTIONS = Object.freeze([
  'send',
  'notify',
  'message',
  'post',
  'email',
  'webhook',
  'call',
  'execute',
  'run',
  'sync',
  'broadcast',
]);

const SECRET_KEY_PATTERNS = Object.freeze([
  /(?:^|[^a-z])api[_-]?key(?:$|[^a-z])/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /bearer/i,
  /credential/i,
  /private\s*key/i,
  /client[_-]?secret/i,
]);

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function toText(value) {
  return normalizeText(value);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeDecisionLabel(value) {
  const text = toText(value);
  if (text === TOOL_GATE_DECISIONS.ALLOW) return TOOL_GATE_DECISIONS.ALLOW;
  if (text === TOOL_GATE_DECISIONS.REVIEW) return TOOL_GATE_DECISIONS.REVIEW;
  if (text === TOOL_GATE_DECISIONS.BLOCK) return TOOL_GATE_DECISIONS.BLOCK;
  if (text === TOOL_GATE_DECISIONS.DRY_RUN_ONLY) return TOOL_GATE_DECISIONS.DRY_RUN_ONLY;
  return '';
}

function normalizeRiskLevel(value) {
  const text = toText(value);
  if (text === 'low' || text === 'minimal') return 'low';
  if (text === 'medium' || text === 'moderate') return 'medium';
  if (text === 'high') return 'high';
  if (text === 'critical' || text === 'severe') return 'critical';
  return 'unknown';
}

function clampScore(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function normalizeArgs(args) {
  if (args == null) return null;
  if (Array.isArray(args)) {
    return args.map(item => normalizeArgs(item));
  }
  if (!isPlainObject(args)) {
    return args;
  }
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = normalizeArgs(value);
  }
  return out;
}

function extractClassifier(input) {
  const classifierSource = isPlainObject(input?.classifier)
    ? input.classifier
    : isPlainObject(input?.ab1)
      ? input.ab1
      : null;

  if (!classifierSource) {
    const version = firstText(input?.classifierVersion, input?.ab1Version);
    const risk = isPlainObject(input?.risk) ? input.risk : null;
    if (!version && !risk) return null;
    return {
      classifierVersion: version || '',
      risk: risk
        ? {
            level: normalizeRiskLevel(risk.level),
            score: clampScore(risk.score, 0.5),
            category: firstText(risk.category, 'unknown') || 'unknown',
          }
        : null,
      valid: Boolean(version || risk),
    };
  }

  const version = firstText(
    classifierSource.classifierVersion,
    classifierSource.version,
    classifierSource.meta && classifierSource.meta.classifierVersion,
    input?.classifierVersion
  );
  const risk = isPlainObject(classifierSource.risk) ? classifierSource.risk : null;
  const normalizedRisk = risk
    ? {
        level: normalizeRiskLevel(risk.level),
        score: clampScore(risk.score, 0.5),
        category: firstText(risk.category, 'unknown') || 'unknown',
      }
    : null;
  const valid = Boolean(version || normalizedRisk);

  return {
    classifierVersion: version || '',
    risk: normalizedRisk,
    valid,
  };
}

function normalizePolicy(policy) {
  if (!isPlainObject(policy)) {
    return {
      policyVersion: AB2_POLICY_VERSION,
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
  const workspaceId = firstText(policy.workspaceId, policy.metadata && policy.metadata.workspaceId, DEFAULT_WORKSPACE_ID);
  const policyVersion = firstText(policy.policyVersion, policy.version, AB2_POLICY_VERSION);

  return {
    ...policy,
    policyVersion,
    minimumDecision,
    workspaceId: workspaceId || DEFAULT_WORKSPACE_ID,
  };
}

function normalizeToolCall(input) {
  const raw = isPlainObject(input) ? input : {};
  const policy = normalizePolicy(raw.policy || raw.gatePolicy || raw.toolGatePolicy || raw.policyOverride);
  const classifier = extractClassifier(raw);
  const args = normalizeArgs(raw.args ?? raw.parameters ?? raw.payload ?? null);
  const action = toText(firstText(raw.action, raw.operation, raw.intent, raw.mode, raw.command, raw.toolAction));
  const toolName = firstText(raw.toolName, raw.tool, raw.name, raw.id, raw.commandName);
  const workspaceId = firstText(raw.workspaceId, raw.workspace, policy.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID;
  const dryRun = Boolean(raw.dryRun ?? raw.dry_run ?? raw.simulate ?? raw.preview);

  return {
    raw,
    action,
    toolName,
    args,
    dryRun,
    workspaceId,
    policy,
    classifier,
  };
}

function hasSecretLookingValue(value, keyPath = []) {
  const keyText = toText(keyPath[keyPath.length - 1] || '');
  if (SECRET_KEY_PATTERNS.some(pattern => pattern.test(keyText))) {
    return true;
  }

  if (typeof value === 'string') {
    if (SECRET_KEY_PATTERNS.some(pattern => pattern.test(value))) return true;
    if (/^sk-[a-z0-9]{10,}$/i.test(value)) return true;
    if (/^Bearer\s+[A-Za-z0-9._\-+/=]{10,}$/i.test(value)) return true;
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item, index) => hasSecretLookingValue(item, keyPath.concat(String(index))));
  }

  if (!isPlainObject(value)) return false;

  return Object.entries(value).some(([key, nested]) => hasSecretLookingValue(nested, keyPath.concat(key)));
}

function hasAnyToken(text, tokens) {
  const norm = toText(text);
  return tokens.some(token => norm.includes(toText(token)));
}

function classifyAction(normalized) {
  const actionText = normalized.action;
  const toolText = normalized.toolName;
  const combined = `${actionText} ${toolText}`.trim();

  if (!combined) {
    return {
      category: 'unknown',
      level: 'unknown',
      score: 0.5,
      reason: TOOL_GATE_REASONS.UNKNOWN_ACTION_REVIEW_REQUIRED,
      decision: TOOL_GATE_DECISIONS.REVIEW,
    };
  }

  if (hasAnyToken(combined, DESTRUCTIVE_ACTIONS)) {
    return {
      category: 'destructive',
      level: 'critical',
      score: 1,
      reason: TOOL_GATE_REASONS.CRITICAL_MUTATION_BLOCKED,
      decision: TOOL_GATE_DECISIONS.BLOCK,
    };
  }

  if (hasAnyToken(combined, DEPLOY_ACTIONS)) {
    return {
      category: 'deploy',
      level: 'high',
      score: 0.85,
      reason: TOOL_GATE_REASONS.HIGH_RISK_ACTION_DRY_RUN_ONLY,
      decision: TOOL_GATE_DECISIONS.DRY_RUN_ONLY,
    };
  }

  if (hasAnyToken(combined, WRITE_ACTIONS)) {
    return {
      category: 'write',
      level: 'medium',
      score: 0.6,
      reason: TOOL_GATE_REASONS.REVIEW_REQUIRED,
      decision: TOOL_GATE_DECISIONS.REVIEW,
    };
  }

  if (hasAnyToken(combined, SIDE_EFFECT_ACTIONS)) {
    return {
      category: 'external_side_effect',
      level: 'high',
      score: 0.8,
      reason: TOOL_GATE_REASONS.EXTERNAL_SIDE_EFFECT_REVIEW_REQUIRED,
      decision: TOOL_GATE_DECISIONS.REVIEW,
    };
  }

  if (hasAnyToken(combined, READ_ONLY_ACTIONS)) {
    return {
      category: 'read',
      level: 'low',
      score: 0.2,
      reason: TOOL_GATE_REASONS.LOW_RISK_ACTION,
      decision: TOOL_GATE_DECISIONS.ALLOW,
    };
  }

  return {
    category: 'unknown',
    level: 'medium',
    score: 0.55,
    reason: TOOL_GATE_REASONS.UNKNOWN_ACTION_REVIEW_REQUIRED,
    decision: TOOL_GATE_DECISIONS.REVIEW,
  };
}

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
  const secretDetected = hasSecretLookingValue(normalized.args);
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
  evaluateToolCall,
  normalizeGateDecision,
  normalizeToolCall,
};
