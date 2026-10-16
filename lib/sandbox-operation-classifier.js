'use strict';

// Runs every sandbox isolation check over one normalised operation and folds
// them into a decision, risk and reason (#2135).
//
// Checks run in a fixed order and each can only raise the decision. The
// reason, though, is overwritten by later checks, so reordering them changes
// which reason an audit sees.

const { resolveTimeoutCeiling, describeTimeoutCeiling } = require('./sandbox-timeout-policy');
const { SANDBOX_ISOLATION_REASONS: R, clampScore, mergeDecision, makeFinding } = require('./sandbox-isolation-vocabulary');
const { hasForbiddenCapabilities, hasExternalNetwork, hasSnapshotAbuse } = require('./sandbox-source-scan');
const { detectTempArtifactRisk } = require('./sandbox-temp-artifact-risk');

/** A blocking check: the decision escalates to block and the risk to critical. */
function block(state, code, reason, detail) {
  state.findings.push(makeFinding({ code, decision: 'block', reason, risk: 'critical', detail }));
  state.decision = mergeDecision(state.decision, 'block');
  state.riskLevel = 'critical';
  state.riskScore = 1.0;
  state.reason = reason;
}

/**
 * A quarantining check. `risk` is the finding's risk: 'high' lifts the level
 * to high unless it is already critical, anything else lifts only low to
 * medium. `keepHarsherReason` leaves a reason set by an earlier blocking
 * check in place.
 */
function quarantine(state, { code, reason, risk, detail, minScore, keepHarsherReason = false }) {
  state.findings.push(makeFinding({ code, decision: 'quarantine', reason, risk, detail }));
  state.decision = mergeDecision(state.decision, 'quarantine');
  if (risk === 'high') {
    if (state.riskLevel !== 'critical') state.riskLevel = 'high';
  } else if (state.riskLevel === 'low') {
    state.riskLevel = 'medium';
  }
  state.riskScore = Math.max(state.riskScore, minScore);
  state.reason = !keepHarsherReason || state.decision === 'quarantine' ? reason : state.reason;
}

function checkRollback(state, context) {
  if (!context.isRollback) return;
  if (!context.hasSnapshot) {
    state.findings.push(makeFinding({
      code: 'NO_SNAPSHOT',
      decision: 'rollback',
      reason: R.ROLLBACK_FAILED_ROLLBACK,
      risk: 'high',
      detail: 'Rollback requested but no snapshot exists.',
    }));
    state.decision = mergeDecision(state.decision, 'rollback');
    state.riskLevel = 'high';
    state.riskScore = 0.7;
    state.reason = R.ROLLBACK_FAILED_ROLLBACK;
    return;
  }
  state.findings.push(makeFinding({
    code: 'SNAPSHOT_RESTORE',
    decision: 'allow',
    reason: R.SNAPSHOT_RESTORE_ALLOW,
    risk: 'low',
    detail: 'Rollback from existing snapshot.',
  }));
  state.riskScore = 0.2;
  state.reason = R.SNAPSHOT_RESTORE_ALLOW;
}

// Only the most severe temp-artifact risk is reported.
function checkTempArtifacts(state, context) {
  const risk = detectTempArtifactRisk(context);
  if (risk.destructiveCleanupOutsideSandbox) {
    block(state, 'DESTRUCTIVE_CLEANUP_OUTSIDE_SANDBOX', R.DESTRUCTIVE_CLEANUP_OUTSIDE_SANDBOX_BLOCK, 'Destructive cleanup outside sandbox is blocked.');
  } else if (risk.pathTraversal) {
    block(state, 'TEMP_ARTIFACT_PATH_TRAVERSAL', R.TEMP_ARTIFACT_PATH_TRAVERSAL_BLOCK, 'Temp artifact path traversal is blocked.');
  } else if (risk.outsideSandbox) {
    quarantine(state, { code: 'TEMP_ARTIFACT_OUTSIDE_SANDBOX', reason: R.TEMP_ARTIFACT_OUTSIDE_SANDBOX_QUARANTINE, risk: 'medium', detail: 'Temp artifacts outside the sandbox are quarantined.', minScore: 0.5 });
  } else if (risk.hasTempArtifact && risk.sandboxRootMissing) {
    quarantine(state, { code: 'TEMP_ARTIFACT_MISSING_SANDBOX_ROOT', reason: R.TEMP_ARTIFACT_MISSING_SANDBOX_ROOT_QUARANTINE, risk: 'medium', detail: 'Temp artifacts without sandbox root require quarantine.', minScore: 0.5 });
  }
}

function checkSourceTrust(state, context) {
  if (context.sourceTrust === 'untrusted') {
    block(state, 'UNTRUSTED_SOURCE', R.UNTRUSTED_SOURCE_BLOCK, 'Untrusted source cannot execute in sandbox.');
  } else if (context.sourceTrust === 'unknown') {
    quarantine(state, { code: 'UNKNOWN_SOURCE_TRUST', reason: R.UNKNOWN_SOURCE_TRUST_QUARANTINE, risk: 'medium', detail: 'Unknown source trust requires review before sandbox execution.', minScore: 0.5 });
  }
}

function checkTimeout(state, context, policy) {
  const timeoutCeiling = resolveTimeoutCeiling(policy);
  if (context.timeoutMs <= timeoutCeiling) return;
  state.findings.push(makeFinding({
    code: 'HIGH_TIMEOUT',
    decision: 'block',
    reason: R.TIMEOUT_EXCEEDED_BLOCK,
    risk: 'high',
    detail: `Timeout ${context.timeoutMs}ms exceeds the ${
      describeTimeoutCeiling(policy)} maximum of ${timeoutCeiling}ms.`,
  }));
  state.decision = mergeDecision(state.decision, 'block');
  if (state.riskLevel !== 'critical') state.riskLevel = 'high';
  state.riskScore = Math.max(state.riskScore, 0.7);
  state.reason = state.decision === 'block' ? R.TIMEOUT_EXCEEDED_BLOCK : state.reason;
}

/** `policy` is optional; absent, the default safe ceiling applies (#1113). */
function classifySandboxOperation(context, policy = null) {
  const state = { findings: [], decision: 'allow', riskLevel: 'low', riskScore: 0.1, reason: R.SOURCE_VALIDATED_ALLOW };

  checkRollback(state, context);
  checkTempArtifacts(state, context);
  checkSourceTrust(state, context);
  if (hasForbiddenCapabilities(context.source)) {
    quarantine(state, { code: 'FORBIDDEN_CAPABILITY', reason: R.FORBIDDEN_CAPABILITY_QUARANTINE, risk: 'high', detail: 'Source contains forbidden capability patterns.', minScore: 0.6, keepHarsherReason: true });
  }
  if (hasExternalNetwork(context.source)) {
    quarantine(state, { code: 'EXTERNAL_NETWORK', reason: R.EXTERNAL_NETWORK_QUARANTINE, risk: 'medium', detail: 'Source contains external network access patterns.', minScore: 0.4, keepHarsherReason: true });
  }
  checkTimeout(state, context, policy);
  if (context.runner === 'unknown') {
    block(state, 'UNKNOWN_RUNNER', R.UNKNOWN_RUNNER_BLOCK, `Unknown runner type ${JSON.stringify(context.runner)} cannot be sandboxed safely.`);
  }
  if (hasSnapshotAbuse(context.snapshotCount, context.snapshotDepth)) {
    block(state, 'SNAPSHOT_ABUSE', R.SNAPSHOT_ABUSE_BLOCK, `Snapshot count ${context.snapshotCount} or depth ${context.snapshotDepth} exceeds safe limits.`);
  }
  if (!context.source && !context.isRollback) {
    quarantine(state, { code: 'EMPTY_SOURCE', reason: R.SANDBOX_VIOLATION_QUARANTINE, risk: 'medium', detail: 'No source provided for sandbox execution.', minScore: 0.4, keepHarsherReason: true });
  }
  if (state.findings.length === 0 && !context.isRollback) {
    state.findings.push(makeFinding({
      code: 'SOURCE_VALIDATED',
      decision: 'allow',
      reason: R.SOURCE_VALIDATED_ALLOW,
      risk: 'low',
      detail: 'Source validated, sandbox execution allowed.',
    }));
    state.riskScore = 0.1;
    state.reason = R.SOURCE_VALIDATED_ALLOW;
  }

  return {
    decision: state.decision,
    riskLevel: state.riskLevel,
    riskScore: clampScore(state.riskScore),
    reason: state.reason,
    findings: state.findings,
  };
}

module.exports = {
  classifySandboxOperation,
};
