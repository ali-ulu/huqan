'use strict';

// The result the sandbox isolation gate returns, its warnings and finding
// summary, and the normaliser callers use to read a stored decision (#2135).

const { isPlainObject } = require('./is-plain-object');
const {
  SANDBOX_ISOLATION_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  clampScore,
  decisionRank,
  decisionFromRank,
  normalizeDecisionLabel,
  normalizeRiskLevel,
} = require('./sandbox-isolation-vocabulary');

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
  if (ctx.context && ctx.context.tempOutsideSandbox === true) {
    warnings.push('Temp artifacts outside sandbox require quarantine or block.');
  }
  if (classification.decision === 'quarantine') {
    warnings.push('Action quarantined; execution may proceed in isolated sandbox only.');
  }
  return warnings;
}

/**
 * The gate's result for a final `decision`. The summary is taken here, after
 * every finding -- policy findings included -- has been added.
 */
function buildResult(ctx, policy, classification, decision) {
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
  summarizeSandboxFindings,
  buildResult,
  normalizeSandboxIsolationDecision,
};
