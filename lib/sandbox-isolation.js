'use strict';

// The sandbox isolation gate (AB6): decides whether an operation may execute
// in the sandbox, must be quarantined, rolled back, or is blocked. This file
// applies operator policy on top of the classification; the vocabulary, input
// normalisation, checks and result shape live in their own modules (#2135).

const { MAX_TIMEOUT_MS } = require('./sandbox-timeout-policy');
const {
  SANDBOX_ISOLATION_DECISIONS,
  SANDBOX_ISOLATION_REASONS,
  SANDBOX_RISK_LEVELS,
  SANDBOX_ISOLATION_POLICY_VERSION,
  SOURCE_TRUST_LEVELS,
  RUNNER_TYPES,
  DEFAULT_TIMEOUT_MS,
  mergeDecision,
  makeFinding,
} = require('./sandbox-isolation-vocabulary');
const { normalizePolicy, normalizeSandboxInput } = require('./sandbox-isolation-input');
const { hasExternalNetwork } = require('./sandbox-source-scan');
const { classifySandboxOperation } = require('./sandbox-operation-classifier');
const { summarizeSandboxFindings, buildResult, normalizeSandboxIsolationDecision } = require('./sandbox-isolation-output');

function evaluateSandboxIsolation(input, options = {}) {
  const ctx = normalizeSandboxInput(input);
  const policy = normalizePolicy(options.policy || {});
  const classification = classifySandboxOperation(ctx, policy);
  let decision = classification.decision;

  if (policy.minimumDecision) {
    decision = mergeDecision(decision, policy.minimumDecision);
  }

  // With no source to run, only the policy floor applies.
  if (!ctx.source && !ctx.isRollback) {
    return buildResult(ctx, policy, classification, decision);
  }

  // POLICY_TIMEOUT_EXCEEDED is gone: classifySandboxOperation now decides on the
  // configured ceiling, and splitting the rule in two is what let them disagree.

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

  if (policy.allowUntrustedSource === false && ctx.sourceTrust === 'untrusted') {
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

  return buildResult(ctx, policy, classification, decision);
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
