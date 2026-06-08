'use strict';

const { normalizeText } = require('./text-utils');

const CODE_CHANGE_GATE_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
  DRY_RUN_ONLY: 'dry_run_only',
});

const CODE_CHANGE_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const CODE_CHANGE_GATE_REASONS = Object.freeze({
  LOW_RISK_DOCS_ONLY: 'LOW_RISK_DOCS_ONLY',
  LOW_RISK_TESTS_ONLY: 'LOW_RISK_TESTS_ONLY',
  NARROW_HELPER_CHANGE: 'NARROW_HELPER_CHANGE',
  SOURCE_CHANGE_REQUIRES_REVIEW: 'SOURCE_CHANGE_REQUIRES_REVIEW',
  RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN: 'RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN',
  PACKAGE_MUTATION_REQUIRES_REVIEW: 'PACKAGE_MUTATION_REQUIRES_REVIEW',
  CI_WORKFLOW_CHANGE_REQUIRES_REVIEW: 'CI_WORKFLOW_CHANGE_REQUIRES_REVIEW',
  RELEASE_OR_DEPLOY_CHANGE_BLOCKED: 'RELEASE_OR_DEPLOY_CHANGE_BLOCKED',
  AUTO_MERGE_OR_AUTOPUSH_BLOCKED: 'AUTO_MERGE_OR_AUTOPUSH_BLOCKED',
  SECRET_CHANGE_BLOCKED: 'SECRET_CHANGE_BLOCKED',
  EMPTY_FILE_LIST_REVIEW_REQUIRED: 'EMPTY_FILE_LIST_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED: 'UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED',
  DIRTY_REPO_REVIEW_REQUIRED: 'DIRTY_REPO_REVIEW_REQUIRED',
  MAIN_BRANCH_WRITE_BLOCKED: 'MAIN_BRANCH_WRITE_BLOCKED',
  BREADTH_REVIEW_REQUIRED: 'BREADTH_REVIEW_REQUIRED',
  CROSS_CUTTING_CHANGE_REVIEW_REQUIRED: 'CROSS_CUTTING_CHANGE_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
});

const CODE_CHANGE_POLICY_VERSION = 'AB3-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';
const BREADTH_REVIEW_THRESHOLD = 6;
const BREADTH_DRY_RUN_THRESHOLD = 10;

const DOC_PATH_HINTS = Object.freeze([
  'readme',
  'changelog',
  'docs/',
  'doc/',
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  'license',
  'contributing',
]);

const TEST_PATH_HINTS = Object.freeze([
  'test/',
  'tests/',
  '__tests__',
  '.test.',
  '.spec.',
]);

const HELPER_PATH_HINTS = Object.freeze([
  'helper',
  'helpers/',
  'util',
  'utils/',
  'normalizer',
  'formatter',
  'sanitizer',
]);

const PACKAGE_PATH_HINTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const WORKFLOW_PATH_HINTS = Object.freeze([
  '.github/workflows/',
  '.github/actions/',
  'workflow',
  'ci/',
  '.circleci/',
  'azure-pipelines',
]);

const RUNTIME_PATH_HINTS = Object.freeze([
  'server.js',
  'mcpserver.js',
  'kernel.js',
  'kernel.v2.js',
  'graph.js',
  'requestguards.js',
  'plugin.js',
  'lib/verify.js',
]);

const MEMORY_PATH_HINTS = Object.freeze([
  'memory/',
  '/memory-',
  'memory.js',
  'memory.',
  'memory_',
]);

const RELEASE_DEPLOY_HINTS = Object.freeze([
  'release',
  'deploy',
  'publish',
  'automerge',
  'auto-merge',
  'auto merge',
  'autopush',
  'auto-push',
  'auto deploy',
  'auto-deploy',
]);

const SECRET_HINTS = Object.freeze([
  'api key',
  'apikey',
  'api_key',
  'api-key',
  'secret',
  'token',
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

function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function normalizeDecisionLabel(value) {
  const text = normalizeText(value);
  if (text === CODE_CHANGE_GATE_DECISIONS.ALLOW) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (text === CODE_CHANGE_GATE_DECISIONS.REVIEW) return CODE_CHANGE_GATE_DECISIONS.REVIEW;
  if (text === CODE_CHANGE_GATE_DECISIONS.BLOCK) return CODE_CHANGE_GATE_DECISIONS.BLOCK;
  if (text === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY) return CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY;
  return '';
}

function normalizeRiskLevel(value) {
  const text = normalizeText(value);
  if (text === 'low' || text === 'minimal') return CODE_CHANGE_RISK_LEVELS.LOW;
  if (text === 'medium' || text === 'moderate') return CODE_CHANGE_RISK_LEVELS.MEDIUM;
  if (text === 'high') return CODE_CHANGE_RISK_LEVELS.HIGH;
  if (text === 'critical' || text === 'severe') return CODE_CHANGE_RISK_LEVELS.CRITICAL;
  return CODE_CHANGE_RISK_LEVELS.MEDIUM;
}

function clampScore(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function decisionRank(decision) {
  const normalized = normalizeDecisionLabel(decision);
  if (normalized === CODE_CHANGE_GATE_DECISIONS.ALLOW) return 0;
  if (normalized === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY) return 1;
  if (normalized === CODE_CHANGE_GATE_DECISIONS.REVIEW) return 2;
  if (normalized === CODE_CHANGE_GATE_DECISIONS.BLOCK) return 3;
  return 2;
}

function decisionFromRank(rank) {
  if (rank <= 0) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (rank === 1) return CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY;
  if (rank === 2) return CODE_CHANGE_GATE_DECISIONS.REVIEW;
  return CODE_CHANGE_GATE_DECISIONS.BLOCK;
}

function mergeDecision(current, requested) {
  return decisionFromRank(Math.max(decisionRank(current), decisionRank(requested)));
}

function includesAny(text, hints) {
  const normalized = normalizeText(text);
  return hints.some(hint => normalized.includes(normalizeText(hint)));
}

function isSecretLikeValue(value, keyPath = []) {
  const keyText = normalizeText(keyPath[keyPath.length - 1] || '');
  if (includesAny(keyText, SECRET_HINTS)) {
    return true;
  }

  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (includesAny(text, SECRET_HINTS)) return true;
    if (/^sk-[a-z0-9]{10,}$/i.test(String(value).trim())) return true;
    if (/^bearer\s+[a-z0-9._\-+/=]{10,}$/i.test(String(value).trim())) return true;
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item, index) => isSecretLikeValue(item, keyPath.concat(String(index))));
  }

  if (!isPlainObject(value)) return false;

  return Object.entries(value).some(([key, nested]) => isSecretLikeValue(nested, keyPath.concat(key)));
}

function isDocsPath(path) {
  const normalized = normalizePath(path).toLowerCase();
  return includesAny(normalized, DOC_PATH_HINTS);
}

function isTestPath(path, changeType) {
  const normalized = normalizePath(path).toLowerCase();
  return normalizeText(changeType) === 'test' || includesAny(normalized, TEST_PATH_HINTS);
}

function isHelperPath(path, changeType) {
  const normalized = normalizePath(path).toLowerCase();
  return normalizeText(changeType) === 'helper' || includesAny(normalized, HELPER_PATH_HINTS);
}

function isPackagePath(path, changeType) {
  const normalized = normalizePath(path).toLowerCase();
  return normalizeText(changeType) === 'package' || includesAny(normalized, PACKAGE_PATH_HINTS);
}

function isWorkflowPath(path, changeType) {
  const normalized = normalizePath(path).toLowerCase();
  return normalizeText(changeType) === 'workflow' || normalizeText(changeType) === 'ci' || includesAny(normalized, WORKFLOW_PATH_HINTS);
}

function isRuntimePath(path, changeType) {
  const normalized = normalizePath(path).toLowerCase();
  return normalizeText(changeType) === 'runtime' || includesAny(normalized, RUNTIME_PATH_HINTS);
}

function isMemoryPath(path, changeType) {
  const normalized = normalizePath(path).toLowerCase();
  return normalizeText(changeType) === 'memory' || includesAny(normalized, MEMORY_PATH_HINTS);
}

function isReleaseOrDeployPath(path, changeType, textSignals) {
  const normalized = normalizePath(path).toLowerCase();
  const signalText = normalizeText([path, changeType, textSignals].filter(Boolean).join(' '));
  return includesAny(normalized, RELEASE_DEPLOY_HINTS) || includesAny(signalText, RELEASE_DEPLOY_HINTS);
}

function isAutoMergePath(path, changeType, textSignals) {
  const signalText = normalizeText([path, changeType, textSignals].filter(Boolean).join(' '));
  return signalText.includes('auto merge') || signalText.includes('auto-merge') || signalText.includes('automerge') || signalText.includes('autopush') || signalText.includes('auto push');
}

function hasWriteLikeOperation(operationType) {
  const text = normalizeText(operationType);
  return ['patch', 'write', 'apply', 'commit', 'update'].includes(text);
}

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
  const files = Array.isArray(raw.files) ? raw.files.map(normalizeFileInput).sort((left, right) => left.path.localeCompare(right.path)) : [];
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

function classifyChangedFile(file, context = {}) {
  const normalized = normalizeFileInput(file);
  const textSignals = [context.intent, context.diffSummary, normalized.path, normalized.changeType].filter(Boolean).join(' ');
  const filePath = normalized.path;

  if (!filePath) {
    return {
      ok: false,
      path: '',
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'malformed',
      riskLevel: CODE_CHANGE_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: CODE_CHANGE_GATE_DECISIONS.REVIEW,
      reason: CODE_CHANGE_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED,
      notes: ['File path is missing.'],
      sensitive: false,
    };
  }

  if (isAutoMergePath(filePath, normalized.changeType, textSignals)) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'auto_merge',
      riskLevel: CODE_CHANGE_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: CODE_CHANGE_GATE_DECISIONS.BLOCK,
      reason: CODE_CHANGE_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED,
      notes: ['Auto-merge or autopush surface detected.'],
      sensitive: true,
    };
  }

  if (isReleaseOrDeployPath(filePath, normalized.changeType, textSignals)) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'release_or_deploy',
      riskLevel: CODE_CHANGE_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: CODE_CHANGE_GATE_DECISIONS.BLOCK,
      reason: CODE_CHANGE_GATE_REASONS.RELEASE_OR_DEPLOY_CHANGE_BLOCKED,
      notes: ['Release or deploy surface detected.'],
      sensitive: true,
    };
  }

  if (isSecretLikeValue({ path: filePath, status: normalized.status, changeType: normalized.changeType, additions: normalized.additions, deletions: normalized.deletions })) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'secret',
      riskLevel: CODE_CHANGE_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: CODE_CHANGE_GATE_DECISIONS.BLOCK,
      reason: CODE_CHANGE_GATE_REASONS.SECRET_CHANGE_BLOCKED,
      notes: ['Sensitive file or metadata pattern detected.'],
      sensitive: true,
    };
  }

  if (isPackagePath(filePath, normalized.changeType)) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'package',
      riskLevel: CODE_CHANGE_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: CODE_CHANGE_GATE_DECISIONS.REVIEW,
      reason: CODE_CHANGE_GATE_REASONS.PACKAGE_MUTATION_REQUIRES_REVIEW,
      notes: ['Package or lockfile mutation detected.'],
      sensitive: false,
    };
  }

  if (isWorkflowPath(filePath, normalized.changeType)) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'workflow',
      riskLevel: CODE_CHANGE_RISK_LEVELS.HIGH,
      riskScore: 0.8,
      decision: CODE_CHANGE_GATE_DECISIONS.REVIEW,
      reason: CODE_CHANGE_GATE_REASONS.CI_WORKFLOW_CHANGE_REQUIRES_REVIEW,
      notes: ['CI or workflow surface detected.'],
      sensitive: false,
    };
  }

  if (isRuntimePath(filePath, normalized.changeType) || isMemoryPath(filePath, normalized.changeType)) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: isMemoryPath(filePath, normalized.changeType) ? 'memory' : 'runtime',
      riskLevel: CODE_CHANGE_RISK_LEVELS.HIGH,
      riskScore: 0.85,
      decision: CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY,
      reason: CODE_CHANGE_GATE_REASONS.RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN,
      notes: ['Runtime, kernel, graph, or memory surface detected.'],
      sensitive: false,
    };
  }

  if (isDocsPath(filePath)) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'docs',
      riskLevel: CODE_CHANGE_RISK_LEVELS.LOW,
      riskScore: 0.15,
      decision: CODE_CHANGE_GATE_DECISIONS.ALLOW,
      reason: CODE_CHANGE_GATE_REASONS.LOW_RISK_DOCS_ONLY,
      notes: ['Docs-only surface detected.'],
      sensitive: false,
    };
  }

  if (isTestPath(filePath, normalized.changeType)) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'tests',
      riskLevel: CODE_CHANGE_RISK_LEVELS.LOW,
      riskScore: 0.15,
      decision: CODE_CHANGE_GATE_DECISIONS.ALLOW,
      reason: CODE_CHANGE_GATE_REASONS.LOW_RISK_TESTS_ONLY,
      notes: ['Tests-only surface detected.'],
      sensitive: false,
    };
  }

  if (isHelperPath(filePath, normalized.changeType)) {
    return {
      ok: true,
      path: filePath,
      status: normalized.status,
      changeType: normalized.changeType,
      category: 'helper',
      riskLevel: CODE_CHANGE_RISK_LEVELS.LOW,
      riskScore: 0.2,
      decision: CODE_CHANGE_GATE_DECISIONS.ALLOW,
      reason: CODE_CHANGE_GATE_REASONS.NARROW_HELPER_CHANGE,
      notes: ['Narrow helper or utility surface detected.'],
      sensitive: false,
    };
  }

  return {
    ok: true,
    path: filePath,
    status: normalized.status,
    changeType: normalized.changeType,
    category: 'source',
    riskLevel: CODE_CHANGE_RISK_LEVELS.MEDIUM,
    riskScore: 0.55,
    decision: CODE_CHANGE_GATE_DECISIONS.REVIEW,
    reason: CODE_CHANGE_GATE_REASONS.SOURCE_CHANGE_REQUIRES_REVIEW,
    notes: ['Generic source change requires review.'],
    sensitive: false,
  };
}

function summarizeFileFindings(fileFindings) {
  const findings = Array.isArray(fileFindings)
    ? fileFindings.map(normalizeCodeChangeDecisionFileFinding).sort((left, right) => left.path.localeCompare(right.path))
    : [];

  if (!findings.length) {
    return {
      fileCount: 0,
      categories: [],
      riskLevel: CODE_CHANGE_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: CODE_CHANGE_GATE_DECISIONS.REVIEW,
      reason: CODE_CHANGE_GATE_REASONS.EMPTY_FILE_LIST_REVIEW_REQUIRED,
      hasCritical: false,
      hasHighRisk: false,
      reasons: [CODE_CHANGE_GATE_REASONS.EMPTY_FILE_LIST_REVIEW_REQUIRED],
    };
  }

  let decision = CODE_CHANGE_GATE_DECISIONS.ALLOW;
  let reason = CODE_CHANGE_GATE_REASONS.LOW_RISK_DOCS_ONLY;
  let riskLevel = CODE_CHANGE_RISK_LEVELS.LOW;
  let riskScore = 0.15;
  const categories = new Set();
  const reasons = [];
  let hasCritical = false;
  let hasHighRisk = false;

  for (const finding of findings) {
    categories.add(finding.category);
    reasons.push(finding.reason);
    decision = mergeDecision(decision, finding.decision);

    const rank = decisionRank(finding.decision);
    if (rank >= 3) {
      hasCritical = true;
      riskLevel = CODE_CHANGE_RISK_LEVELS.CRITICAL;
      riskScore = 1;
      reason = finding.reason;
      continue;
    }
    if (rank === 2 && decisionRank(reasonToDecision(reason)) < 2) {
      riskLevel = CODE_CHANGE_RISK_LEVELS.MEDIUM;
      riskScore = Math.max(riskScore, 0.55);
      reason = finding.reason;
    }
    if (rank === 1) {
      hasHighRisk = true;
      riskLevel = CODE_CHANGE_RISK_LEVELS.HIGH;
      riskScore = Math.max(riskScore, 0.85);
      reason = finding.reason;
    }
    if (rank === 0) {
      reason = finding.reason;
    }
  }

  const categoryList = [...categories].sort();
  const broadCategories = categoryList.filter(category => category !== 'docs' && category !== 'tests' && category !== 'helper');
  if (broadCategories.length > 1) {
    hasHighRisk = true;
    if (riskLevel === CODE_CHANGE_RISK_LEVELS.LOW) {
      riskLevel = CODE_CHANGE_RISK_LEVELS.MEDIUM;
      riskScore = Math.max(riskScore, 0.55);
    }
  }

  if (hasCritical) {
    decision = CODE_CHANGE_GATE_DECISIONS.BLOCK;
    reason = reasons.find(item => item === CODE_CHANGE_GATE_REASONS.RELEASE_OR_DEPLOY_CHANGE_BLOCKED)
      || reasons.find(item => item === CODE_CHANGE_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED)
      || reasons.find(item => item === CODE_CHANGE_GATE_REASONS.SECRET_CHANGE_BLOCKED)
      || reason;
    riskLevel = CODE_CHANGE_RISK_LEVELS.CRITICAL;
    riskScore = 1;
  } else if (hasHighRisk && decision === CODE_CHANGE_GATE_DECISIONS.ALLOW) {
    decision = CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY;
    riskLevel = CODE_CHANGE_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
    reason = CODE_CHANGE_GATE_REASONS.BREADTH_REVIEW_REQUIRED;
  }

  if (decision === CODE_CHANGE_GATE_DECISIONS.REVIEW && !hasHighRisk) {
    riskLevel = riskLevel === CODE_CHANGE_RISK_LEVELS.LOW ? CODE_CHANGE_RISK_LEVELS.MEDIUM : riskLevel;
    riskScore = Math.max(riskScore, 0.55);
  }

  return {
    fileCount: findings.length,
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

function reasonToDecision(reason) {
  if (reason === CODE_CHANGE_GATE_REASONS.LOW_RISK_DOCS_ONLY) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (reason === CODE_CHANGE_GATE_REASONS.LOW_RISK_TESTS_ONLY) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (reason === CODE_CHANGE_GATE_REASONS.NARROW_HELPER_CHANGE) return CODE_CHANGE_GATE_DECISIONS.ALLOW;
  if (reason === CODE_CHANGE_GATE_REASONS.RUNTIME_ENTRYPOINT_REQUIRES_DRY_RUN) return CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY;
  if (reason === CODE_CHANGE_GATE_REASONS.RELEASE_OR_DEPLOY_CHANGE_BLOCKED) return CODE_CHANGE_GATE_DECISIONS.BLOCK;
  if (reason === CODE_CHANGE_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED) return CODE_CHANGE_GATE_DECISIONS.BLOCK;
  if (reason === CODE_CHANGE_GATE_REASONS.SECRET_CHANGE_BLOCKED) return CODE_CHANGE_GATE_DECISIONS.BLOCK;
  return CODE_CHANGE_GATE_DECISIONS.REVIEW;
}

function normalizeCodeChangeDecisionFileFinding(finding) {
  const raw = isPlainObject(finding) ? finding : {};
  const path = normalizePath(raw.path);
  const status = firstText(raw.status, 'modified');
  const changeType = normalizeText(firstText(raw.changeType, 'source')) || 'source';
  const category = firstText(raw.category, 'source');
  const reason = firstText(raw.reason, CODE_CHANGE_GATE_REASONS.SOURCE_CHANGE_REQUIRES_REVIEW);
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(Boolean).map(note => String(note)) : [];
  return {
    ok: Boolean(raw.ok ?? true),
    path,
    status,
    changeType,
    category,
    riskLevel: normalizeRiskLevel(raw.riskLevel),
    riskScore: clampScore(raw.riskScore, 0.5),
    decision: normalizeDecisionLabel(raw.decision) || CODE_CHANGE_GATE_DECISIONS.REVIEW,
    reason,
    notes,
    sensitive: Boolean(raw.sensitive),
  };
}

function normalizeCodeChangeDecision(decision) {
  const raw = isPlainObject(decision) ? decision : {};
  const normalizedDecision = normalizeDecisionLabel(raw.decision);
  const normalizedRisk = isPlainObject(raw.risk) ? raw.risk : {};
  const normalizedFileFindings = Array.isArray(raw.fileFindings)
    ? raw.fileFindings.map(normalizeCodeChangeDecisionFileFinding).sort((left, right) => left.path.localeCompare(right.path))
    : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean).map(value => String(value)) : [];
  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};

  return {
    ok: Boolean(raw.ok ?? true),
    allowed: normalizedDecision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    canApply: normalizedDecision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    canDryRun: normalizedDecision !== CODE_CHANGE_GATE_DECISIONS.BLOCK,
    decision: normalizedDecision || CODE_CHANGE_GATE_DECISIONS.REVIEW,
    reason: firstText(raw.reason, CODE_CHANGE_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED),
    risk: {
      level: normalizeRiskLevel(normalizedRisk.level),
      score: clampScore(normalizedRisk.score, 0.5),
      categories: Array.isArray(normalizedRisk.categories)
        ? [...new Set(normalizedRisk.categories.filter(Boolean).map(value => String(value)))].sort()
        : [],
    },
    requiredReview: normalizedDecision !== CODE_CHANGE_GATE_DECISIONS.ALLOW,
    dryRunOnly: normalizedDecision === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY,
    fileFindings: normalizedFileFindings,
    warnings,
    metadata: {
      policyVersion: firstText(metadata.policyVersion, CODE_CHANGE_POLICY_VERSION),
      workspaceId: firstText(metadata.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    },
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
      reason: raised === CODE_CHANGE_GATE_DECISIONS.BLOCK
        ? CODE_CHANGE_GATE_REASONS.POLICY_OVERRIDE_BLOCK
        : CODE_CHANGE_GATE_REASONS.POLICY_OVERRIDE_REVIEW,
    };
  }

  return { decision, reason };
}

function evaluateCodeChange(input, options = {}) {
  const normalized = normalizeCodeChangeInput({
    ...(isPlainObject(input) ? input : {}),
    policyOverride: options.policy || (isPlainObject(input) ? input.policyOverride : null),
  });

  const fileFindings = normalized.files.map(file => classifyChangedFile(file, normalized));
  const summary = summarizeFileFindings(fileFindings);
  const warnings = [];
  let decision = summary.decision;
  let reason = summary.reason;
  let riskLevel = summary.riskLevel;
  let riskScore = summary.riskScore;
  const secretDetected = isSecretLikeValue({
    intent: normalized.intent,
    diffSummary: normalized.diffSummary,
    patchMetadata: isPlainObject(normalized.raw.patchMetadata) ? normalized.raw.patchMetadata : normalized.patchMetadata,
    metadata: isPlainObject(normalized.raw.metadata) ? normalized.raw.metadata : normalized.metadata,
    files: normalized.files,
  });

  if (normalized.malformed) {
    decision = mergeDecision(decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    reason = CODE_CHANGE_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED;
    warnings.push('Malformed code change input detected.');
  }

  if (!normalized.files.length) {
    decision = mergeDecision(decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    reason = CODE_CHANGE_GATE_REASONS.EMPTY_FILE_LIST_REVIEW_REQUIRED;
    warnings.push('No files were provided.');
  }

  if (normalized.operationType === 'unknown') {
    decision = mergeDecision(decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    reason = CODE_CHANGE_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED;
    warnings.push('Unknown operation type detected.');
  }

  if (normalized.repoState.dirty || normalized.repoState.hasUntracked) {
    decision = mergeDecision(decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    reason = CODE_CHANGE_GATE_REASONS.DIRTY_REPO_REVIEW_REQUIRED;
    warnings.push('Dirty root or untracked files detected.');
  }

  if (normalized.repoState.isMain && hasWriteLikeOperation(normalized.operationType) && normalized.files.length > 0) {
    decision = CODE_CHANGE_GATE_DECISIONS.BLOCK;
    reason = CODE_CHANGE_GATE_REASONS.MAIN_BRANCH_WRITE_BLOCKED;
    warnings.push('Write attempt on main branch blocked.');
  }

  if (secretDetected) {
    decision = CODE_CHANGE_GATE_DECISIONS.BLOCK;
    reason = CODE_CHANGE_GATE_REASONS.SECRET_CHANGE_BLOCKED;
    warnings.push('Sensitive content detected in change metadata.');
  }

  const fileCount = normalized.patchMetadata.fileCount || normalized.files.length;
  if (fileCount >= BREADTH_REVIEW_THRESHOLD && summary.categories.some(category => !['docs', 'tests', 'helper'].includes(category))) {
    const broadDecision = fileCount >= BREADTH_DRY_RUN_THRESHOLD
      ? CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY
      : CODE_CHANGE_GATE_DECISIONS.REVIEW;
    if (decision === CODE_CHANGE_GATE_DECISIONS.ALLOW) {
      decision = broadDecision;
      reason = CODE_CHANGE_GATE_REASONS.BREADTH_REVIEW_REQUIRED;
    } else {
      decision = mergeDecision(decision, broadDecision);
    }
    riskLevel = CODE_CHANGE_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
    warnings.push('Broad change spans many files.');
  }

  if (summary.categories.filter(category => !['docs', 'tests', 'helper'].includes(category)).length > 1) {
    if (decision === CODE_CHANGE_GATE_DECISIONS.ALLOW) {
      decision = CODE_CHANGE_GATE_DECISIONS.REVIEW;
      reason = CODE_CHANGE_GATE_REASONS.CROSS_CUTTING_CHANGE_REVIEW_REQUIRED;
    }
    riskLevel = riskLevel === CODE_CHANGE_RISK_LEVELS.LOW ? CODE_CHANGE_RISK_LEVELS.MEDIUM : riskLevel;
    riskScore = Math.max(riskScore, 0.55);
    warnings.push('Cross-cutting change across multiple surfaces detected.');
  }

  const policyApplied = applyPolicyFloor(decision, reason, normalized.policy);
  decision = policyApplied.decision;
  reason = policyApplied.reason;

  if (decision === CODE_CHANGE_GATE_DECISIONS.ALLOW) {
    riskLevel = CODE_CHANGE_RISK_LEVELS.LOW;
    riskScore = Math.min(riskScore, 0.2);
  } else if (decision === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY) {
    riskLevel = riskLevel === CODE_CHANGE_RISK_LEVELS.CRITICAL ? CODE_CHANGE_RISK_LEVELS.CRITICAL : CODE_CHANGE_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
  } else if (decision === CODE_CHANGE_GATE_DECISIONS.REVIEW) {
    riskLevel = riskLevel === CODE_CHANGE_RISK_LEVELS.CRITICAL ? CODE_CHANGE_RISK_LEVELS.CRITICAL : (riskLevel === CODE_CHANGE_RISK_LEVELS.HIGH ? CODE_CHANGE_RISK_LEVELS.HIGH : CODE_CHANGE_RISK_LEVELS.MEDIUM);
    riskScore = Math.max(riskScore, 0.55);
  } else {
    riskLevel = CODE_CHANGE_RISK_LEVELS.CRITICAL;
    riskScore = 1;
  }

  const result = {
    ok: true,
    allowed: decision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    canApply: decision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    canDryRun: decision !== CODE_CHANGE_GATE_DECISIONS.BLOCK,
    decision,
    reason,
    risk: {
      level: riskLevel,
      score: clampScore(riskScore, 0.5),
      categories: summary.categories,
    },
    requiredReview: decision !== CODE_CHANGE_GATE_DECISIONS.ALLOW,
    dryRunOnly: decision === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY,
    fileFindings,
    warnings,
    metadata: {
      policyVersion: normalized.policy.policyVersion || CODE_CHANGE_POLICY_VERSION,
      workspaceId: normalized.metadata.workspaceId || DEFAULT_WORKSPACE_ID,
    },
  };

  return normalizeCodeChangeDecision(result);
}

module.exports = {
  CODE_CHANGE_GATE_DECISIONS,
  CODE_CHANGE_GATE_REASONS,
  CODE_CHANGE_POLICY_VERSION,
  CODE_CHANGE_RISK_LEVELS,
  evaluateCodeChange,
  normalizeCodeChangeDecision,
  normalizeCodeChangeInput,
  classifyChangedFile,
  summarizeFileFindings,
};
