// #2151: turning an untrusted tool call, classifier output and policy into
// the normalized shape every later step reads.

const { normalizeText } = require('./text-utils');
const { isPlainObject } = require('./is-plain-object');
const { AB2_POLICY_VERSION, DEFAULT_WORKSPACE_ID, TOOL_GATE_DECISIONS } = require('./tool-call-gate-vocabulary');

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
  // The un-lowercased action is kept alongside the normalized one so word
  // boundaries in `getStatus` survive long enough to be tokenized (#764).
  const actionRaw = firstText(raw.action, raw.operation, raw.intent, raw.mode, raw.command, raw.toolAction);
  const action = toText(actionRaw);
  const toolName = firstText(raw.toolName, raw.tool, raw.name, raw.id, raw.commandName);
  const workspaceId = firstText(raw.workspaceId, raw.workspace, policy.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID;
  const dryRun = Boolean(raw.dryRun ?? raw.dry_run ?? raw.simulate ?? raw.preview);

  return {
    raw,
    action,
    actionRaw,
    toolName,
    args,
    dryRun,
    workspaceId,
    policy,
    classifier,
  };
}

module.exports = {
  clampScore,
  firstText,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  normalizeToolCall,
  toText,
};
