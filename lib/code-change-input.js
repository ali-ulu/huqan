'use strict';

// Turns whatever a caller hands the code-change gate into one shape (#2134).
// Nothing here decides; a missing or malformed field becomes a safe default.

const { normalizeText } = require('./text-utils');
const { isPlainObject } = require('./is-plain-object');
const {
  CODE_CHANGE_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  firstText,
  normalizePath,
  compareCodePoints,
  normalizeDecisionLabel,
} = require('./code-change-gate-vocabulary');

function normalizeOperationType(value) {
  const text = normalizeText(value);
  if (!text) return 'unknown';
  if (['patch', 'write', 'apply', 'commit', 'update'].includes(text)) return text;
  if (['preview', 'diff', 'inspect', 'plan', 'dry run', 'dry-run', 'dry_run'].includes(text)) return text.replace(/\s+/g, '_').replace(/-/g, '_');
  return 'unknown';
}

function normalizePolicy(policy) {
  if (!isPlainObject(policy)) {
    return {
      policyVersion: CODE_CHANGE_POLICY_VERSION,
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
    policyVersion: firstText(policy.policyVersion, policy.version, CODE_CHANGE_POLICY_VERSION),
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

function normalizePatchMetadata(patchMetadata) {
  const raw = isPlainObject(patchMetadata) ? patchMetadata : {};
  return {
    fileCount: Math.max(0, Number(raw.fileCount ?? 0) || 0),
    totalAdditions: Math.max(0, Number(raw.totalAdditions ?? raw.additions ?? 0) || 0),
    totalDeletions: Math.max(0, Number(raw.totalDeletions ?? raw.deletions ?? 0) || 0),
  };
}

function normalizeFileInput(file) {
  const raw = isPlainObject(file) ? file : {};
  const path = normalizePath(raw.path);
  return {
    raw,
    path,
    status: firstText(raw.status, 'modified'),
    changeType: normalizeText(firstText(raw.changeType, raw.type, 'source')) || 'source',
    additions: Math.max(0, Number(raw.additions ?? 0) || 0),
    deletions: Math.max(0, Number(raw.deletions ?? 0) || 0),
  };
}

function normalizeMetadata(metadata) {
  const raw = isPlainObject(metadata) ? metadata : {};
  return {
    workspaceId: firstText(raw.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
  };
}

function normalizeCodeChangeInput(input) {
  const raw = isPlainObject(input) ? input : {};
  const policy = normalizePolicy(raw.policyOverride || raw.policy || raw.gatePolicy || raw.codeChangePolicy);
  const files = Array.isArray(raw.files) ? raw.files.map(normalizeFileInput).sort((left, right) => compareCodePoints(left.path, right.path)) : [];
  const intent = firstText(raw.intent);
  const operationType = normalizeOperationType(raw.operationType);
  const diffSummary = firstText(raw.diffSummary);
  const patchMetadata = normalizePatchMetadata(raw.patchMetadata);
  const repoState = normalizeRepoState(raw.repoState);
  const priorDecisions = isPlainObject(raw.priorDecisions) ? raw.priorDecisions : {};
  const metadata = normalizeMetadata(raw.metadata || raw.contextMetadata);
  const malformed = !isPlainObject(input) || !Array.isArray(raw.files);

  return {
    raw,
    files,
    intent,
    operationType,
    diffSummary,
    patchMetadata,
    repoState,
    priorDecisions,
    policy,
    metadata,
    malformed,
  };
}

module.exports = {
  normalizeFileInput,
  normalizeCodeChangeInput,
};
