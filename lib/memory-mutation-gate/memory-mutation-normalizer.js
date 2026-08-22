'use strict';

const { normalizeText } = require('../text-utils');
const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_RISK_LEVELS,
  DEFAULT_WORKSPACE_ID,
  MEMORY_MUTATION_POLICY_VERSION,
  SECRET_HINTS,
} = require('./memory-mutation-vocabulary');

const { isPlainObject } = require('../is-plain-object');

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function containsAny(text, tokens) {
  const normalized = normalizeText(text);
  return tokens.some(token => normalized.includes(normalizeText(token)));
}

function normalizeDecisionLabel(value) {
  const text = normalizeText(value);
  if (text === MEMORY_MUTATION_GATE_DECISIONS.ALLOW) return MEMORY_MUTATION_GATE_DECISIONS.ALLOW;
  if (text === MEMORY_MUTATION_GATE_DECISIONS.REVIEW) return MEMORY_MUTATION_GATE_DECISIONS.REVIEW;
  if (text === MEMORY_MUTATION_GATE_DECISIONS.BLOCK) return MEMORY_MUTATION_GATE_DECISIONS.BLOCK;
  if (text === MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY) return MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY;
  return '';
}

function normalizeRiskLevel(value) {
  const text = normalizeText(value);
  if (text === 'low' || text === 'minimal') return MEMORY_MUTATION_RISK_LEVELS.LOW;
  if (text === 'medium' || text === 'moderate') return MEMORY_MUTATION_RISK_LEVELS.MEDIUM;
  if (text === 'high') return MEMORY_MUTATION_RISK_LEVELS.HIGH;
  if (text === 'critical' || text === 'severe') return MEMORY_MUTATION_RISK_LEVELS.CRITICAL;
  return MEMORY_MUTATION_RISK_LEVELS.MEDIUM;
}

function clampScore(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function decisionRank(decision) {
  const normalized = normalizeDecisionLabel(decision);
  if (normalized === MEMORY_MUTATION_GATE_DECISIONS.ALLOW) return 0;
  if (normalized === MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY) return 1;
  if (normalized === MEMORY_MUTATION_GATE_DECISIONS.REVIEW) return 2;
  if (normalized === MEMORY_MUTATION_GATE_DECISIONS.BLOCK) return 3;
  return 2;
}

function decisionFromRank(rank) {
  if (rank <= 0) return MEMORY_MUTATION_GATE_DECISIONS.ALLOW;
  if (rank === 1) return MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY;
  if (rank === 2) return MEMORY_MUTATION_GATE_DECISIONS.REVIEW;
  return MEMORY_MUTATION_GATE_DECISIONS.BLOCK;
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
      policyVersion: MEMORY_MUTATION_POLICY_VERSION,
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
    policyVersion: firstText(policy.policyVersion, policy.version, MEMORY_MUTATION_POLICY_VERSION),
    minimumDecision,
    workspaceId: firstText(policy.workspaceId, policy.metadata && policy.metadata.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
  };
}

function normalizeRepoState(repoState) {
  const raw = isPlainObject(repoState) ? repoState : {};
  const branch = firstText(raw.branch, raw.currentBranch, '');
  const normalizedBranch = normalizeText(branch);
  return {
    branch,
    isMain: Boolean(raw.isMain ?? (normalizedBranch === 'main' || normalizedBranch.endsWith('/main'))),
    dirty: Boolean(raw.dirty),
    hasUntracked: Boolean(raw.hasUntracked),
  };
}

function normalizeMutationMetadata(mutationMetadata) {
  const raw = isPlainObject(mutationMetadata) ? mutationMetadata : {};
  return {
    entryCount: Math.max(0, Number(raw.entryCount ?? raw.count ?? 0) || 0),
    patchCount: Math.max(0, Number(raw.patchCount ?? 0) || 0),
    linkCount: Math.max(0, Number(raw.linkCount ?? 0) || 0),
    auditCount: Math.max(0, Number(raw.auditCount ?? 0) || 0),
    workspaceCount: Math.max(0, Number(raw.workspaceCount ?? 0) || 0),
    crossWorkspaceCount: Math.max(0, Number(raw.crossWorkspaceCount ?? 0) || 0),
    contentCount: Math.max(0, Number(raw.contentCount ?? 0) || 0),
    graphCount: Math.max(0, Number(raw.graphCount ?? 0) || 0),
  };
}

function normalizeEntry(entry, context = {}) {
  const raw = isPlainObject(entry) ? entry : {};
  const id = firstText(raw.id, raw.memoryId, raw.entryId, raw.key, '');
  const action = normalizeText(firstText(raw.action, raw.operation, raw.mode, raw.intent, raw.kind, raw.type, ''));
  const changeType = normalizeText(firstText(raw.changeType, raw.category, raw.mutationType, raw.kind, ''));
  const scope = normalizeText(firstText(raw.scope, raw.targetSpace, raw.workspaceId, context.targetSpace, context.metadata && context.metadata.workspaceId, DEFAULT_WORKSPACE_ID));
  const workspaceId = firstText(raw.workspaceId, raw.workspace, raw.targetSpace, scope, context.targetSpace, context.metadata && context.metadata.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID;
  const contentChanged = Boolean(raw.contentChanged ?? raw.content ?? raw.contentRewrite ?? raw.rewriteContent);
  const linksChanged = Boolean(raw.linksChanged ?? raw.linkChanged ?? raw.relationChanged ?? raw.graphChanged);
  const auditChanged = Boolean(raw.auditChanged ?? raw.auditRewrite ?? raw.auditDelete ?? raw.auditWrite);
  const deleted = Boolean(raw.deleted ?? raw.deletedAt ?? raw.tombstoned);
  const tombstoned = Boolean(raw.tombstoned ?? raw.tombstone);
  const superseded = Boolean(raw.superseded ?? raw.supersede);
  // Fail closed (#378): a caller that omits every change flag is not
  // automatically metadata-only. Only an explicit `metadataOnly: true`
  // counts -- inferring it from "no flags set" let a caller who simply
  // forgot to declare contentChanged/linksChanged/etc. slip through the
  // lower-risk metadata-only path.
  const metadataOnly = raw.metadataOnly === true;
  return {
    raw,
    id,
    action,
    changeType,
    scope,
    workspaceId,
    contentChanged,
    linksChanged,
    auditChanged,
    deleted,
    tombstoned,
    superseded,
    metadataOnly,
  };
}

function normalizeMemoryMutationInput(input) {
  const raw = isPlainObject(input) ? input : {};
  const policy = normalizePolicy(raw.policyOverride || raw.policy || raw.gatePolicy || raw.memoryMutationPolicy);
  const entries = Array.isArray(raw.entries) ? raw.entries.map(entry => normalizeEntry(entry, raw)).sort((left, right) => `${left.workspaceId}:${left.id}`.localeCompare(`${right.workspaceId}:${right.id}`)) : [];
  const operationType = normalizeText(firstText(raw.operationType, raw.operation, raw.mode, ''));
  const mutationType = normalizeText(firstText(raw.mutationType, raw.category, raw.kind, ''));
  const targetSpace = firstText(raw.targetSpace, raw.workspaceId, policy.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID;
  const diffSummary = firstText(raw.diffSummary, raw.summary, '');
  const mutationMetadata = normalizeMutationMetadata(raw.mutationMetadata);
  const repoState = normalizeRepoState(raw.repoState);
  const priorDecisions = isPlainObject(raw.priorDecisions) ? raw.priorDecisions : {};
  const metadata = {
    workspaceId: firstText(raw.metadata && raw.metadata.workspaceId, raw.workspaceId, policy.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
  };
  const malformed = !isPlainObject(input) || !Array.isArray(raw.entries);

  return {
    raw,
    entries,
    operationType,
    mutationType,
    targetSpace,
    diffSummary,
    mutationMetadata,
    repoState,
    priorDecisions,
    policy,
    metadata,
    malformed,
  };
}

module.exports = {
  isPlainObject,
  firstText,
  normalizePath,
  containsAny,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  clampScore,
  decisionRank,
  decisionFromRank,
  mergeDecision,
  isSecretLikeValue,
  normalizePolicy,
  normalizeRepoState,
  normalizeMutationMetadata,
  normalizeEntry,
  normalizeMemoryMutationInput,
};
