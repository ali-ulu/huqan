'use strict';

const SANDBOX_ISOLATION_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  QUARANTINE: 'quarantine',
  BLOCK: 'block',
  ROLLBACK: 'rollback',
});

const SANDBOX_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const SANDBOX_ISOLATION_REASONS = Object.freeze({
  SOURCE_VALIDATED_ALLOW: 'SOURCE_VALIDATED_ALLOW',
  SNAPSHOT_RESTORE_ALLOW: 'SNAPSHOT_RESTORE_ALLOW',
  READ_ONLY_EXECUTION_ALLOW: 'READ_ONLY_EXECUTION_ALLOW',
  SANDBOX_VIOLATION_QUARANTINE: 'SANDBOX_VIOLATION_QUARANTINE',
  FORBIDDEN_CAPABILITY_QUARANTINE: 'FORBIDDEN_CAPABILITY_QUARANTINE',
  EXTERNAL_NETWORK_QUARANTINE: 'EXTERNAL_NETWORK_QUARANTINE',
  UNTRUSTED_SOURCE_BLOCK: 'UNTRUSTED_SOURCE_BLOCK',
  TIMEOUT_EXCEEDED_BLOCK: 'TIMEOUT_EXCEEDED_BLOCK',
  RESOURCE_EXHAUSTION_BLOCK: 'RESOURCE_EXHAUSTION_BLOCK',
  SNAPSHOT_ABUSE_BLOCK: 'SNAPSHOT_ABUSE_BLOCK',
  ROLLBACK_FAILED_ROLLBACK: 'ROLLBACK_FAILED_ROLLBACK',
  SNAPSHOT_INTEGRITY_ROLLBACK: 'SNAPSHOT_INTEGRITY_ROLLBACK',
  STATE_LEAK_DETECTED_ROLLBACK: 'STATE_LEAK_DETECTED_ROLLBACK',
  UNKNOWN_EXECUTION_REVIEW_REQUIRED: 'UNKNOWN_EXECUTION_REVIEW_REQUIRED',
  MALFORMED_INPUT_REVIEW_REQUIRED: 'MALFORMED_INPUT_REVIEW_REQUIRED',
  POLICY_OVERRIDE_REVIEW: 'POLICY_OVERRIDE_REVIEW',
  POLICY_OVERRIDE_BLOCK: 'POLICY_OVERRIDE_BLOCK',
});

const SANDBOX_ISOLATION_POLICY_VERSION = 'AB6-v0.1.0';
const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_TIMEOUT_MS = 150;
const MAX_TIMEOUT_MS = 5000;

const SOURCE_TRUST_LEVELS = Object.freeze({
  VALIDATED: 'validated',
  UNTRUSTED: 'untrusted',
  UNKNOWN: 'unknown',
});

const RUNNER_TYPES = Object.freeze({
  NODE_VM: 'node:vm',
  WORKER: 'worker',
  ISOLATED_VM: 'isolated-vm',
  UNKNOWN: 'unknown',
});

const FORBIDDEN_CAPABILITY_HINTS = Object.freeze([
  'require',
  'process',
  'globalThis',
  'global',
  'module',
  'exports',
  'Function',
  'eval',
  'import(',
  'constructor',
  'child_process',
  'fs',
  'net',
  'http',
  'https',
  'dgram',
  'cluster',
  'worker_threads',
]);

const EXTERNAL_NETWORK_HINTS = Object.freeze([
  'http',
  'https',
  'fetch',
  'request',
  'websocket',
  'socket',
  'dns',
  'net.connect',
  'XMLHttpRequest',
]);

const SNAPSHOT_ABUSE_HINTS = Object.freeze([
  'snapshot_count_exceeded',
  'recursive_snapshot',
  'deep_snapshot_chain',
  'snapshot_memory_bomb',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function firstText(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function containsAny(text, tokens) {
  const lower = normalizeText(text);
  return tokens.some(token => lower.includes(normalizeText(token)));
}

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function decisionRank(decision) {
  const ranks = {
    allow: 0,
    quarantine: 1,
    rollback: 2,
    block: 3,
  };
  return ranks[decision] !== undefined ? ranks[decision] : -1;
}

function decisionFromRank(rank) {
  const byRank = ['allow', 'quarantine', 'rollback', 'block'];
  return byRank[rank] || 'block';
}

function mergeDecision(current, requested) {
  const currentRank = decisionRank(current);
  const requestedRank = decisionRank(requested);
  if (currentRank < 0 || requestedRank < 0) return 'block';
  return currentRank >= requestedRank ? current : requested;
}

function normalizeDecisionLabel(value) {
  const valid = new Set(Object.values(SANDBOX_ISOLATION_DECISIONS));
  const text = normalizeText(value);
  return valid.has(text) ? text : 'block';
}

function normalizeRiskLevel(value) {
  const valid = new Set(Object.values(SANDBOX_RISK_LEVELS));
  const text = normalizeText(value);
  return valid.has(text) ? text : 'medium';
}

function normalizeSourceTrust(value) {
  const valid = new Set(Object.values(SOURCE_TRUST_LEVELS));
  const text = normalizeText(value);
  return valid.has(text) ? text : 'unknown';
}

function normalizeRunnerType(value) {
  const valid = new Set(Object.values(RUNNER_TYPES));
  const text = normalizeText(value);
  return valid.has(text) ? text : 'unknown';
}

function normalizePolicy(policy) {
  if (!isPlainObject(policy)) return {};
  const out = {};
  if (typeof policy.minimumDecision === 'string') {
    out.minimumDecision = normalizeDecisionLabel(policy.minimumDecision);
  }
  if (typeof policy.maximumTimeoutMs === 'number' && policy.maximumTimeoutMs > 0) {
    out.maximumTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(policy.maximumTimeoutMs)));
  }
  if (typeof policy.allowExternalNetwork === 'boolean') {
    out.allowExternalNetwork = policy.allowExternalNetwork;
  }
  if (typeof policy.allowUntustedSource === 'boolean') {
    out.allowUntustedSource = policy.allowUntustedSource;
  }
  if (typeof policy.maxSnapshotDepth === 'number' && policy.maxSnapshotDepth >= 0) {
    out.maxSnapshotDepth = Math.min(100, Math.max(0, Math.round(policy.maxSnapshotDepth)));
  }
  return out;
}

function normalizeSandboxInput(input) {
  if (!isPlainObject(input)) {
    return {
      source: '',
      sourceTrust: 'unknown',
      runner: 'unknown',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      hasSnapshot: false,
      snapshotDepth: 0,
      snapshotCount: 0,
      isRollback: false,
      bindings: {},
      context: {},
      metadata: { workspaceId: DEFAULT_WORKSPACE_ID },
    };
  }

  const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(input.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const snapshotDepth = typeof input.snapshotDepth === 'number' && input.snapshotDepth >= 0
    ? Math.round(input.snapshotDepth)
    : 0;

  const snapshotCount = typeof input.snapshotCount === 'number' && input.snapshotCount >= 0
    ? Math.round(input.snapshotCount)
    : 0;

  return {
    source: String(input.source || ''),
    sourceTrust: normalizeSourceTrust(input.sourceTrust),
    runner: normalizeRunnerType(input.runner),
    timeoutMs,
    hasSnapshot: input.hasSnapshot === true,
    snapshotDepth,
    snapshotCount,
    isRollback: input.isRollback === true,
    bindings: isPlainObject(input.bindings) ? { ...input.bindings } : {},
    context: isPlainObject(input.context) ? { ...input.context } : {},
    metadata: isPlainObject(input.metadata) ? { ...input.metadata } : { workspaceId: DEFAULT_WORKSPACE_ID },
  };
}

function makeFinding(overrides = {}) {
  return {
    code: String(overrides.code || 'UNKNOWN'),
    decision: normalizeDecisionLabel(overrides.decision || 'block'),
    reason: String(overrides.reason || ''),
    risk: normalizeRiskLevel(overrides.risk || 'medium'),
    detail: String(overrides.detail || ''),
  };
}

function hasForbiddenCapabilities(source) {
  return containsAny(source, FORBIDDEN_CAPABILITY_HINTS);
}

function hasExternalNetwork(source) {
  return containsAny(source, EXTERNAL_NETWORK_HINTS);
}

function hasSnapshotAbuse(snapshotCount, snapshotDepth) {
  if (snapshotCount > 50) return true;
  if (snapshotDepth > 20) return true;
  return false;
}

function classifySandboxOperation(context) {
  const findings = [];
  let decision = 'allow';
  let riskLevel = 'low';
  let riskScore = 0.1;
  let reason = SANDBOX_ISOLATION_REASONS.SOURCE_VALIDATED_ALLOW;

  if (context.isRollback) {
    if (!context.hasSnapshot) {
      findings.push(makeFinding({
        code: 'NO_SNAPSHOT',
        decision: 'rollback',
        reason: SANDBOX_ISOLATION_REASONS.ROLLBACK_FAILED_ROLLBACK,
        risk: 'high',
        detail: 'Rollback requested but no snapshot exists.',
      }));
      decision = mergeDecision(decision, 'rollback');
      riskLevel = 'high';
      riskScore = 0.7;
      reason = SANDBOX_ISOLATION_REASONS.ROLLBACK_FAILED_ROLLBACK;
    } else {
      findings.push(makeFinding({
        code: 'SNAPSHOT_RESTORE',
        decision: 'allow',
        reason: SANDBOX_ISOLATION_REASONS.SNAPSHOT_RESTORE_ALLOW,
        risk: 'low',
        detail: 'Rollback from existing snapshot.',
      }));
      riskScore = 0.2;
      reason = SANDBOX_ISOLATION_REASONS.SNAPSHOT_RESTORE_ALLOW;
    }
  }

  if (context.sourceTrust === 'untrusted') {
    findings.push(makeFinding({
      code: 'UNTRUSTED_SOURCE',
      decision: 'block',
      reason: SANDBOX_ISOLATION_REASONS.UNTRUSTED_SOURCE_BLOCK,
      risk: 'critical',
      detail: 'Untrusted source cannot execute in sandbox.',
    }));
    decision = mergeDecision(decision, 'block');
    riskLevel = 'critical';
    riskScore = 1.0;
    reason = SANDBOX_ISOLATION_REASONS.UNTRUSTED_SOURCE_BLOCK;
  }

  if (hasForbiddenCapabilities(context.source)) {
    findings.push(makeFinding({
      code: 'FORBIDDEN_CAPABILITY',
      decision: 'quarantine',
      reason: SANDBOX_ISOLATION_REASONS.FORBIDDEN_CAPABILITY_QUARANTINE,
      risk: 'high',
      detail: 'Source contains forbidden capability patterns.',
    }));
    decision = mergeDecision(decision, 'quarantine');
    if (riskLevel !== 'critical') riskLevel = 'high';
    riskScore = Math.max(riskScore, 0.6);
    reason = decision === 'quarantine'
      ? SANDBOX_ISOLATION_REASONS.FORBIDDEN_CAPABILITY_QUARANTINE
      : reason;
  }

  if (hasExternalNetwork(context.source)) {
    findings.push(makeFinding({
      code: 'EXTERNAL_NETWORK',
      decision: 'quarantine',
      reason: SANDBOX_ISOLATION_REASONS.EXTERNAL_NETWORK_QUARANTINE,
      risk: 'medium',
      detail: 'Source contains external network access patterns.',
    }));
    decision = mergeDecision(decision, 'quarantine');
    if (riskLevel === 'low') riskLevel = 'medium';
    riskScore = Math.max(riskScore, 0.4);
    reason = decision === 'quarantine'
      ? SANDBOX_ISOLATION_REASONS.EXTERNAL_NETWORK_QUARANTINE
      : reason;
  }

  if (context.timeoutMs > 1000) {
    findings.push(makeFinding({
      code: 'HIGH_TIMEOUT',
      decision: 'block',
      reason: SANDBOX_ISOLATION_REASONS.TIMEOUT_EXCEEDED_BLOCK,
      risk: 'high',
      detail: `Timeout ${context.timeoutMs}ms exceeds safe threshold.`,
    }));
    decision = mergeDecision(decision, 'block');
    if (riskLevel !== 'critical') riskLevel = 'high';
    riskScore = Math.max(riskScore, 0.7);
    reason = decision === 'block'
      ? SANDBOX_ISOLATION_REASONS.TIMEOUT_EXCEEDED_BLOCK
      : reason;
  }

  if (context.runner === 'unknown') {
    findings.push(makeFinding({
      code: 'UNKNOWN_RUNNER',
      decision: 'block',
      reason: SANDBOX_ISOLATION_REASONS.RESOURCE_EXHAUSTION_BLOCK,
      risk: 'critical',
      detail: 'Unknown runner type cannot be sandboxed safely.',
    }));
    decision = mergeDecision(decision, 'block');
    riskLevel = 'critical';
    riskScore = 1.0;
    reason = SANDBOX_ISOLATION_REASONS.RESOURCE_EXHAUSTION_BLOCK;
  }

  if (hasSnapshotAbuse(context.snapshotCount, context.snapshotDepth)) {
    findings.push(makeFinding({
      code: 'SNAPSHOT_ABUSE',
      decision: 'block',
      reason: SANDBOX_ISOLATION_REASONS.SNAPSHOT_ABUSE_BLOCK,
      risk: 'critical',
      detail: `Snapshot count ${context.snapshotCount} or depth ${context.snapshotDepth} exceeds safe limits.`,
    }));
    decision = mergeDecision(decision, 'block');
    riskLevel = 'critical';
    riskScore = 1.0;
    reason = SANDBOX_ISOLATION_REASONS.SNAPSHOT_ABUSE_BLOCK;
  }

  if (!context.source && !context.isRollback) {
    findings.push(makeFinding({
      code: 'EMPTY_SOURCE',
      decision: 'quarantine',
      reason: SANDBOX_ISOLATION_REASONS.SANDBOX_VIOLATION_QUARANTINE,
      risk: 'medium',
      detail: 'No source provided for sandbox execution.',
    }));
    decision = mergeDecision(decision, 'quarantine');
    if (riskLevel === 'low') riskLevel = 'medium';
    riskScore = Math.max(riskScore, 0.4);
    reason = decision === 'quarantine'
      ? SANDBOX_ISOLATION_REASONS.SANDBOX_VIOLATION_QUARANTINE
      : reason;
  }

  if (findings.length === 0 && !context.isRollback) {
    findings.push(makeFinding({
      code: 'SOURCE_VALIDATED',
      decision: 'allow',
      reason: SANDBOX_ISOLATION_REASONS.SOURCE_VALIDATED_ALLOW,
      risk: 'low',
      detail: 'Source validated, sandbox execution allowed.',
    }));
    riskScore = 0.1;
    reason = SANDBOX_ISOLATION_REASONS.SOURCE_VALIDATED_ALLOW;
  }

  return {
    decision,
    riskLevel,
    riskScore: clampScore(riskScore),
    reason,
    findings,
  };
}

function summarizeSandboxFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return { count: 0, worstDecision: 'allow', worstRisk: 'low', codes: [] };
  }
  let worstRank = 0;
  let worstRiskRank = 0;
  const riskRanks = { low: 0, medium: 1, high: 2, critical: 3 };
  const codes = [];
  for (const f of findings) {
    const r = decisionRank(f.decision);
    if (r > worstRank) worstRank = r;
    const rr = riskRanks[f.risk] || 0;
    if (rr > worstRiskRank) worstRiskRank = rr;
    if (f.code) codes.push(f.code);
  }
  const worstDecision = decisionFromRank(worstRank);
  const worstRisk = Object.keys(riskRanks)[worstRiskRank] || 'low';
  return { count: findings.length, worstDecision, worstRisk, codes };
}

function evaluateSandboxIsolation(input, options = {}) {
  const ctx = normalizeSandboxInput(input);
  const policy = normalizePolicy(options.policy || {});

  if (!ctx.source && !ctx.isRollback) {
    const classification = classifySandboxOperation(ctx);
    return buildOutput(ctx, policy, classification);
  }

  const classification = classifySandboxOperation(ctx);
  let decision = classification.decision;

  if (policy.minimumDecision) {
    decision = mergeDecision(decision, policy.minimumDecision);
  }

  if (policy.maximumTimeoutMs && ctx.timeoutMs > policy.maximumTimeoutMs) {
    decision = mergeDecision(decision, 'block');
    classification.findings.push(makeFinding({
      code: 'POLICY_TIMEOUT_EXCEEDED',
      decision: 'block',
      reason: SANDBOX_ISOLATION_REASONS.TIMEOUT_EXCEEDED_BLOCK,
      risk: 'high',
      detail: `Timeout ${ctx.timeoutMs}ms exceeds policy maximum ${policy.maximumTimeoutMs}ms.`,
    }));
  }

  if (policy.allowExternalNetwork === false && hasExternalNetwork(ctx.source)) {
    decision = mergeDecision(decision, 'block');
    classification.findings.push(makeFinding({
      code: 'POLICY_EXTERNAL_NETWORK_BLOCKED',
      decision: 'block',
      reason: SANDBOX_ISOLATION_REASONS.EXTERNAL_NETWORK_QUARANTINE,
      risk: 'high',
      detail: 'External network access blocked by policy.',
    }));
  }

  if (policy.allowUntustedSource === false && ctx.sourceTrust === 'untrusted') {
    decision = mergeDecision(decision, 'block');
  }

  if (policy.maxSnapshotDepth !== undefined && ctx.snapshotDepth > policy.maxSnapshotDepth) {
    decision = mergeDecision(decision, 'block');
    classification.findings.push(makeFinding({
      code: 'POLICY_SNAPSHOT_DEPTH_EXCEEDED',
      decision: 'block',
      reason: SANDBOX_ISOLATION_REASONS.SNAPSHOT_ABUSE_BLOCK,
      risk: 'critical',
      detail: `Snapshot depth ${ctx.snapshotDepth} exceeds policy maximum ${policy.maxSnapshotDepth}.`,
    }));
  }

  const summary = summarizeSandboxFindings(classification.findings);

  return {
    ok: true,
    allowed: decision === 'allow',
    canExecute: decision === 'allow',
    canDryRun: decision !== 'block',
    canRollback: ctx.hasSnapshot && decision !== 'block',
    decision,
    reason: classification.reason,
    risk: {
      level: classification.riskLevel,
      score: classification.riskScore,
    },
    requiredReview: decision === 'quarantine',
    dryRunOnly: false,
    findings: classification.findings,
    summary,
    warnings: buildWarnings(ctx, policy, classification),
    metadata: {
      policyVersion: SANDBOX_ISOLATION_POLICY_VERSION,
      workspaceId: ctx.metadata.workspaceId || DEFAULT_WORKSPACE_ID,
      runner: ctx.runner,
      sourceTrust: ctx.sourceTrust,
      hasSnapshot: ctx.hasSnapshot,
      snapshotDepth: ctx.snapshotDepth,
    },
  };
}

function buildOutput(ctx, policy, classification) {
  let decision = classification.decision;
  if (policy.minimumDecision) {
    decision = mergeDecision(decision, policy.minimumDecision);
  }
  const summary = summarizeSandboxFindings(classification.findings);
  return {
    ok: true,
    allowed: decision === 'allow',
    canExecute: decision === 'allow',
    canDryRun: decision !== 'block',
    canRollback: ctx.hasSnapshot && decision !== 'block',
    decision,
    reason: classification.reason,
    risk: {
      level: classification.riskLevel,
      score: classification.riskScore,
    },
    requiredReview: decision === 'quarantine',
    dryRunOnly: false,
    findings: classification.findings,
    summary,
    warnings: buildWarnings(ctx, policy, classification),
    metadata: {
      policyVersion: SANDBOX_ISOLATION_POLICY_VERSION,
      workspaceId: ctx.metadata.workspaceId || DEFAULT_WORKSPACE_ID,
      runner: ctx.runner,
      sourceTrust: ctx.sourceTrust,
      hasSnapshot: ctx.hasSnapshot,
      snapshotDepth: ctx.snapshotDepth,
    },
  };
}

function buildWarnings(ctx, policy, classification) {
  const warnings = [];
  if (ctx.sourceTrust === 'unknown') {
    warnings.push('Source trust level is unknown; defaulting to quarantine-safe evaluation.');
  }
  if (ctx.runner === 'unknown') {
    warnings.push('Unknown runner type; sandbox isolation cannot be guaranteed.');
  }
  if (ctx.timeoutMs > 500) {
    warnings.push(`Timeout ${ctx.timeoutMs}ms is above recommended threshold of 500ms.`);
  }
  if (classification.decision === 'quarantine') {
    warnings.push('Action quarantined; execution may proceed in isolated sandbox only.');
  }
  return warnings;
}

function normalizeSandboxIsolationDecision(decision) {
  if (!isPlainObject(decision)) return decision;
  return {
    ok: decision.ok === true,
    allowed: decision.allowed === true,
    canExecute: decision.canExecute === true,
    canDryRun: decision.canDryRun === true,
    canRollback: decision.canRollback === true,
    decision: normalizeDecisionLabel(decision.decision),
    reason: String(decision.reason || ''),
    risk: {
      level: normalizeRiskLevel(decision.risk && decision.risk.level),
      score: clampScore(decision.risk && decision.risk.score),
    },
    requiredReview: decision.requiredReview === true,
    dryRunOnly: decision.dryRunOnly === true,
    findings: Array.isArray(decision.findings) ? decision.findings.map(f => ({
      code: String(f.code || ''),
      decision: normalizeDecisionLabel(f.decision),
      reason: String(f.reason || ''),
      risk: normalizeRiskLevel(f.risk),
      detail: String(f.detail || ''),
    })) : [],
    summary: isPlainObject(decision.summary) ? {
      count: Number(decision.summary.count) || 0,
      worstDecision: normalizeDecisionLabel(decision.summary.worstDecision),
      worstRisk: normalizeRiskLevel(decision.summary.worstRisk),
      codes: Array.isArray(decision.summary.codes) ? decision.summary.codes.map(String) : [],
    } : { count: 0, worstDecision: 'allow', worstRisk: 'low', codes: [] },
    warnings: Array.isArray(decision.warnings) ? decision.warnings.map(String) : [],
    metadata: isPlainObject(decision.metadata) ? {
      policyVersion: String(decision.metadata.policyVersion || ''),
      workspaceId: String(decision.metadata.workspaceId || DEFAULT_WORKSPACE_ID),
      runner: String(decision.metadata.runner || ''),
      sourceTrust: String(decision.metadata.sourceTrust || ''),
      hasSnapshot: decision.metadata.hasSnapshot === true,
      snapshotDepth: Number(decision.metadata.snapshotDepth) || 0,
    } : { policyVersion: '', workspaceId: DEFAULT_WORKSPACE_ID, runner: '', sourceTrust: '', hasSnapshot: false, snapshotDepth: 0 },
  };
}

module.exports = {
  SANDBOX_ISOLATION_DECISIONS,
  SANDBOX_ISOLATION_REASONS,
  SANDBOX_RISK_LEVELS,
  SANDBOX_ISOLATION_POLICY_VERSION,
  SOURCE_TRUST_LEVELS,
  RUNNER_TYPES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  evaluateSandboxIsolation,
  normalizeSandboxInput,
  normalizeSandboxIsolationDecision,
  classifySandboxOperation,
  summarizeSandboxFindings,
};
