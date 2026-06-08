'use strict';

const { normalizeText } = require('./text-utils');

const MEMORY_MUTATION_GATE_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
  DRY_RUN_ONLY: 'dry_run_only',
});

const MEMORY_MUTATION_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const MEMORY_MUTATION_GATE_REASONS = Object.freeze({
  LOW_RISK_MEMORY_INSPECTION: 'LOW_RISK_MEMORY_INSPECTION',
  LOW_RISK_METADATA_ONLY: 'LOW_RISK_METADATA_ONLY',
  NARROW_NOTE_OR_LINK_CHANGE: 'NARROW_NOTE_OR_LINK_CHANGE',
  CONTENT_EDIT_REQUIRES_REVIEW: 'CONTENT_EDIT_REQUIRES_REVIEW',
  GRAPH_MUTATION_REQUIRES_REVIEW: 'GRAPH_MUTATION_REQUIRES_REVIEW',
  CANONICAL_GRAPH_MUTATION_BLOCKED: 'CANONICAL_GRAPH_MUTATION_BLOCKED',
  AUDIT_REWRITE_OR_DELETE_BLOCKED: 'AUDIT_REWRITE_OR_DELETE_BLOCKED',
  CROSS_WORKSPACE_MUTATION_BLOCKED: 'CROSS_WORKSPACE_MUTATION_BLOCKED',
  SECRET_MUTATION_BLOCKED: 'SECRET_MUTATION_BLOCKED',
  PACKAGE_OR_IMPORT_REQUIRES_REVIEW: 'PACKAGE_OR_IMPORT_REQUIRES_REVIEW',
  SYNC_OR_REBUILD_REQUIRES_REVIEW: 'SYNC_OR_REBUILD_REQUIRES_REVIEW',
  RELEASE_OR_DEPLOY_MUTATION_BLOCKED: 'RELEASE_OR_DEPLOY_MUTATION_BLOCKED',
  AUTO_MERGE_OR_AUTOPUSH_BLOCKED: 'AUTO_MERGE_OR_AUTOPUSH_BLOCKED',
  EMPTY_ENTRY_LIST_REVIEW_REQUIRED: 'EMPTY_ENTRY_LIST_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED: 'UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED',
  DIRTY_REPO_REVIEW_REQUIRED: 'DIRTY_REPO_REVIEW_REQUIRED',
  MAIN_BRANCH_WRITE_BLOCKED: 'MAIN_BRANCH_WRITE_BLOCKED',
  BREADTH_REVIEW_REQUIRED: 'BREADTH_REVIEW_REQUIRED',
  CROSS_CUTTING_CHANGE_REVIEW_REQUIRED: 'CROSS_CUTTING_CHANGE_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
});

const MEMORY_MUTATION_POLICY_VERSION = 'AB4-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';
const BREADTH_REVIEW_THRESHOLD = 5;
const BREADTH_DRY_RUN_THRESHOLD = 8;

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

const READ_ACTIONS = Object.freeze([
  'read',
  'inspect',
  'list',
  'query',
  'search',
  'view',
  'show',
  'open',
  'check',
  'status',
  'get',
]);

const NOTE_ACTIONS = Object.freeze([
  'note',
  'annotate',
  'comment',
  'tag',
  'label',
]);

const CONTENT_ACTIONS = Object.freeze([
  'write',
  'upsert',
  'update',
  'edit',
  'patch',
  'save',
  'store',
  'rewrite',
  'modify',
]);

const GRAPH_ACTIONS = Object.freeze([
  'link',
  'unlink',
  'supersede',
  'tombstone',
  'reference',
  'related',
  'contradict',
  'support',
  'edge',
  'relation',
  'graph',
]);

const DELETE_ACTIONS = Object.freeze([
  'delete',
  'remove',
  'destroy',
  'purge',
  'erase',
  'drop',
]);

const AUDIT_ACTIONS = Object.freeze([
  'audit',
  'log',
  'trail',
  'evidence',
  'rewrite',
  'delete',
]);

const PACKAGE_ACTIONS = Object.freeze([
  'package',
  'import',
  'sync',
  'rebuild',
  'rehydrate',
  'batch',
]);

const RELEASE_ACTIONS = Object.freeze([
  'release',
  'deploy',
  'publish',
  'ship',
  'promote',
  'rollout',
]);

const AUTO_ACTIONS = Object.freeze([
  'automerge',
  'auto merge',
  'auto-merge',
  'autopush',
  'auto push',
  'auto-push',
  'auto deploy',
  'auto-deploy',
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
  const metadataOnly = Boolean(raw.metadataOnly ?? (!contentChanged && !linksChanged && !auditChanged && !deleted && !tombstoned && !superseded));
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

function isReadOnlyEntry(entry) {
  const signal = [entry.action, entry.changeType].filter(Boolean).join(' ');
  return containsAny(signal, READ_ACTIONS) && !entry.contentChanged && !entry.linksChanged && !entry.auditChanged && !entry.deleted && !entry.tombstoned && !entry.superseded;
}

function isMetadataOnlyEntry(entry) {
  const signal = [entry.action, entry.changeType].filter(Boolean).join(' ');
  return containsAny(signal, NOTE_ACTIONS) || entry.metadataOnly;
}

function isAuditMutation(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return containsAny(signal, AUDIT_ACTIONS) && (containsAny(signal, ['rewrite', 'delete']) || entry.auditChanged);
}

function isCrossWorkspaceEntry(entry, context) {
  const targetSpace = normalizeText(context.targetSpace || context.metadata.workspaceId || DEFAULT_WORKSPACE_ID);
  const entrySpace = normalizeText(entry.workspaceId || entry.scope || targetSpace);
  return Boolean(targetSpace && entrySpace && entrySpace !== targetSpace);
}

function isReleaseOrAutoMutation(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return containsAny(signal, RELEASE_ACTIONS) || containsAny(signal, AUTO_ACTIONS);
}

function isPackageOrImportMutation(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return containsAny(signal, PACKAGE_ACTIONS);
}

function isSecretMutation(entry, context) {
  return isSecretLikeValue({
    id: entry.id,
    action: entry.action,
    changeType: entry.changeType,
    scope: entry.scope,
    workspaceId: entry.workspaceId,
    diffSummary: context.diffSummary,
    mutationMetadata: context.mutationMetadata,
  });
}

function hasGraphMutation(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return entry.linksChanged || entry.tombstoned || entry.superseded || containsAny(signal, GRAPH_ACTIONS);
}

function isDestructiveDelete(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return entry.deleted || containsAny(signal, DELETE_ACTIONS);
}

function classifyMemoryMutation(entry, context = {}) {
  const normalized = normalizeEntry(entry, context);
  const signal = [normalized.action, normalized.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');

  if (!normalized.id && !normalized.action && !normalized.changeType && !normalized.scope) {
    return {
      ok: false,
      id: '',
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'malformed',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: MEMORY_MUTATION_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED,
      notes: ['Memory entry could not be normalized.'],
      sensitive: false,
      contentChanged: false,
      linksChanged: false,
      auditChanged: false,
    };
  }

  if (isCrossWorkspaceEntry(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'cross_workspace',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: MEMORY_MUTATION_GATE_REASONS.CROSS_WORKSPACE_MUTATION_BLOCKED,
      notes: ['Entry workspace does not match the target workspace.'],
      sensitive: true,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isSecretMutation(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'secret',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: MEMORY_MUTATION_GATE_REASONS.SECRET_MUTATION_BLOCKED,
      notes: ['Sensitive token-like content detected.'],
      sensitive: true,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isAuditMutation(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'audit',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: MEMORY_MUTATION_GATE_REASONS.AUDIT_REWRITE_OR_DELETE_BLOCKED,
      notes: ['Audit rewrite/delete surface detected.'],
      sensitive: true,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isReleaseOrAutoMutation(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'release_or_auto',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: containsAny(signal, RELEASE_ACTIONS)
        ? MEMORY_MUTATION_GATE_REASONS.RELEASE_OR_DEPLOY_MUTATION_BLOCKED
        : MEMORY_MUTATION_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED,
      notes: ['Release/deploy or auto-merge surface detected.'],
      sensitive: true,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isDestructiveDelete(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'delete',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: MEMORY_MUTATION_GATE_REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED,
      notes: ['Destructive delete surface detected.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (hasGraphMutation(normalized, context)) {
    const graphSignal = [normalized.action, normalized.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
    const isBroadGraph = Boolean(context.mutationMetadata && (context.mutationMetadata.entryCount >= BREADTH_DRY_RUN_THRESHOLD || context.mutationMetadata.graphCount >= 3 || context.mutationMetadata.linkCount >= 3));
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'graph',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.HIGH,
      riskScore: 0.85,
      decision: isBroadGraph ? MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY : MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: containsAny(graphSignal, ['supersede', 'tombstone', 'link', 'relation', 'edge'])
        ? MEMORY_MUTATION_GATE_REASONS.GRAPH_MUTATION_REQUIRES_REVIEW
        : MEMORY_MUTATION_GATE_REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED,
      notes: ['Canonical graph-adjacent mutation detected.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isPackageOrImportMutation(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'package_import',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: MEMORY_MUTATION_GATE_REASONS.PACKAGE_OR_IMPORT_REQUIRES_REVIEW,
      notes: ['Package/import/sync surface detected.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isReadOnlyEntry(normalized)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'read_only',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.LOW,
      riskScore: 0.15,
      decision: MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
      reason: MEMORY_MUTATION_GATE_REASONS.LOW_RISK_MEMORY_INSPECTION,
      notes: ['Read-only memory inspection.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isMetadataOnlyEntry(normalized)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'metadata',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.LOW,
      riskScore: 0.2,
      decision: MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
      reason: MEMORY_MUTATION_GATE_REASONS.LOW_RISK_METADATA_ONLY,
      notes: ['Metadata-only memory change.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (normalized.contentChanged) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'content',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.55,
      decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: MEMORY_MUTATION_GATE_REASONS.CONTENT_EDIT_REQUIRES_REVIEW,
      notes: ['Memory content edit detected.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  return {
    ok: true,
    id: normalized.id,
    action: normalized.action,
    changeType: normalized.changeType,
    scope: normalized.scope,
    workspaceId: normalized.workspaceId,
    targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
    category: 'unknown',
    riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
    riskScore: 0.55,
    decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
    reason: MEMORY_MUTATION_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED,
    notes: ['Memory mutation surface could not be safely categorized.'],
    sensitive: false,
    contentChanged: normalized.contentChanged,
    linksChanged: normalized.linksChanged,
    auditChanged: normalized.auditChanged,
  };
}

function normalizeMemoryMutationFinding(finding) {
  const raw = isPlainObject(finding) ? finding : {};
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(Boolean).map(value => String(value)) : [];
  return {
    ok: Boolean(raw.ok ?? true),
    id: firstText(raw.id, ''),
    action: normalizeText(firstText(raw.action, '')),
    changeType: normalizeText(firstText(raw.changeType, '')),
    scope: normalizeText(firstText(raw.scope, '')),
    workspaceId: firstText(raw.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    targetSpace: firstText(raw.targetSpace, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    category: firstText(raw.category, 'unknown'),
    riskLevel: normalizeRiskLevel(raw.riskLevel),
    riskScore: clampScore(raw.riskScore, 0.5),
    decision: normalizeDecisionLabel(raw.decision) || MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
    reason: firstText(raw.reason, MEMORY_MUTATION_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED),
    notes,
    sensitive: Boolean(raw.sensitive),
    contentChanged: Boolean(raw.contentChanged),
    linksChanged: Boolean(raw.linksChanged),
    auditChanged: Boolean(raw.auditChanged),
  };
}

function summarizeMemoryMutationFindings(findings) {
  const normalizedFindings = Array.isArray(findings)
    ? findings.map(normalizeMemoryMutationFinding).sort((left, right) => `${left.workspaceId}:${left.id}`.localeCompare(`${right.workspaceId}:${right.id}`))
    : [];

  if (!normalizedFindings.length) {
    return {
      entryCount: 0,
      categories: [],
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: MEMORY_MUTATION_GATE_REASONS.EMPTY_ENTRY_LIST_REVIEW_REQUIRED,
      hasCritical: false,
      hasHighRisk: false,
      reasons: [MEMORY_MUTATION_GATE_REASONS.EMPTY_ENTRY_LIST_REVIEW_REQUIRED],
    };
  }

  let decision = MEMORY_MUTATION_GATE_DECISIONS.ALLOW;
  let reason = MEMORY_MUTATION_GATE_REASONS.LOW_RISK_MEMORY_INSPECTION;
  let riskLevel = MEMORY_MUTATION_RISK_LEVELS.LOW;
  let riskScore = 0.15;
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
      riskLevel = MEMORY_MUTATION_RISK_LEVELS.CRITICAL;
      riskScore = 1;
      reason = finding.reason;
      continue;
    }
    if (rank === 2) {
      if (riskLevel === MEMORY_MUTATION_RISK_LEVELS.LOW) {
        riskLevel = MEMORY_MUTATION_RISK_LEVELS.MEDIUM;
        riskScore = Math.max(riskScore, 0.55);
      }
      reason = finding.reason;
    }
    if (rank === 1) {
      hasHighRisk = true;
      riskLevel = MEMORY_MUTATION_RISK_LEVELS.HIGH;
      riskScore = Math.max(riskScore, 0.85);
      reason = finding.reason;
    }
    if (rank === 0) {
      reason = finding.reason;
    }
  }

  const categoryList = [...categories].sort();
  const nonReadCategories = categoryList.filter(category => !['read_only', 'metadata'].includes(category));
  if (nonReadCategories.length > 1) {
    hasHighRisk = true;
  }

  if (hasCritical) {
    decision = MEMORY_MUTATION_GATE_DECISIONS.BLOCK;
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.CRITICAL;
    riskScore = 1;
    reason = reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.AUDIT_REWRITE_OR_DELETE_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.CROSS_WORKSPACE_MUTATION_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.SECRET_MUTATION_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.RELEASE_OR_DEPLOY_MUTATION_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED)
      || reason;
  } else if (hasHighRisk && decision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW) {
    decision = MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY;
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
    reason = MEMORY_MUTATION_GATE_REASONS.BREADTH_REVIEW_REQUIRED;
  } else if (hasHighRisk && decision === MEMORY_MUTATION_GATE_DECISIONS.REVIEW) {
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
  } else if (decision === MEMORY_MUTATION_GATE_DECISIONS.REVIEW) {
    riskLevel = riskLevel === MEMORY_MUTATION_RISK_LEVELS.LOW ? MEMORY_MUTATION_RISK_LEVELS.MEDIUM : riskLevel;
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
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_POLICY_VERSION,
  MEMORY_MUTATION_RISK_LEVELS,
  evaluateMemoryMutation,
  normalizeMemoryMutationInput,
  normalizeMemoryMutationDecision,
  classifyMemoryMutation,
  summarizeMemoryMutationFindings,
};
