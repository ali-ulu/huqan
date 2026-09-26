'use strict';

// The external action guard: evaluates one normalized external action through
// every applicable gate and returns the merged, finalized decision. Rules,
// gate helpers, finalization, outcome records, the identity phase and the
// gate phase live in external-action-guard-*.js (#2173).

const { RISK_LEVELS } = require('./action-risk-classifier');
const { riskLevelForScore } = require('./risk-scale');
const { resolvePathWithinRoot } = require('./path-safety');
const { isControlPlanePath, findControlPlaneCommandTarget } = require('./control-plane-paths');
const { normalizeExternalActionEnvelope, EXTERNAL_ACTION_KINDS } = require('./external-action-envelope');
const { postActionMonitoringOptions } = require('./post-action-monitor');
const { finalize, mergeDecision, normalizeScore } = require('./external-action-guard-gates');
const { evaluateIdentityPhase } = require('./external-action-guard-identity');
const { evaluateGatePhase } = require('./external-action-guard-gate-phase');
const { recordExternalActionOutcome, recordExternalActionReview } = require('./external-action-guard-records');
const { EXTERNAL_ACTION_DECISIONS, EXTERNAL_ACTION_REASONS, SHELL_SIDE_EFFECT_RULES } = require('./external-action-guard-rules');

function evaluateExternalAction(input, options = {}) {
  const envelope = normalizeExternalActionEnvelope(input, options);
  const continuousMonitoring = postActionMonitoringOptions(options);
  const findings = [];
  const state = {
    decision: EXTERNAL_ACTION_DECISIONS.ALLOW,
    reason: EXTERNAL_ACTION_REASONS.ALLOWED,
    riskLevel: RISK_LEVELS.LOW,
    riskScore: 10,
  };

  evaluateIdentityPhase(envelope, options, continuousMonitoring, findings, state);

  if (envelope.malformed) {
    state.decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
    state.reason = EXTERNAL_ACTION_REASONS.MALFORMED;
    state.riskLevel = RISK_LEVELS.CRITICAL;
    state.riskScore = 100;
    findings.push({ gate: 'envelope', decision: state.decision, reason: state.reason, flags: envelope.errors });
    return finalize(envelope, { decision: state.decision, reason: state.reason, risk: { level: state.riskLevel, score: state.riskScore }, findings }, options);
  }

  if ([EXTERNAL_ACTION_KINDS.FILE_READ, EXTERNAL_ACTION_KINDS.FILE_WRITE].includes(envelope.kind)
      && envelope.target.path) {
    const absoluteTarget = require('node:path').resolve(envelope.cwd, envelope.target.path);
    try {
      resolvePathWithinRoot(envelope.workspaceRoot, absoluteTarget, { allowMissing: true });
    } catch (_) {
      state.decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
      state.reason = EXTERNAL_ACTION_REASONS.OUTSIDE_WORKSPACE;
      state.riskLevel = RISK_LEVELS.CRITICAL;
      state.riskScore = 100;
      findings.push({ gate: 'path-safety', decision: state.decision, reason: state.reason });
    }
  }

  // The guard's own wiring outranks ordinary workspace paths: a write here
  // decides whether any later action is evaluated at all, so it cannot be one
  // more `ask` among many. `allowControlPlane` comes from the deployment that
  // installed the hook and is never read off the invocation, so an agent
  // cannot grant itself the exemption by asking for it.
  if (!options.allowControlPlane) {
    const controlPlane = envelope.kind === EXTERNAL_ACTION_KINDS.SHELL
      ? findControlPlaneCommandTarget(envelope.command)
      : (envelope.kind === EXTERNAL_ACTION_KINDS.FILE_WRITE ? isControlPlanePath(envelope.target.path) : null);
    if (controlPlane) {
      state.decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
      state.reason = EXTERNAL_ACTION_REASONS.CONTROL_PLANE;
      state.riskLevel = RISK_LEVELS.CRITICAL;
      state.riskScore = 100;
      findings.push({ gate: 'control-plane', decision: state.decision, reason: state.reason, profile: controlPlane.profile, path: controlPlane.path });
    }
  }

  evaluateGatePhase(envelope, options, findings, state);

  for (const finding of findings) {
    state.riskScore = Math.max(state.riskScore, normalizeScore(finding));
  }
  if (state.decision === EXTERNAL_ACTION_DECISIONS.BLOCK) {
    state.reason = findings.findLast(finding => finding.decision === 'block')?.reason || EXTERNAL_ACTION_REASONS.BLOCKED;
    state.riskLevel = RISK_LEVELS.CRITICAL;
    state.riskScore = Math.max(state.riskScore, 95);
  } else if (state.decision === EXTERNAL_ACTION_DECISIONS.REVIEW) {
    state.reason = EXTERNAL_ACTION_REASONS.REVIEW;
    state.riskScore = Math.max(state.riskScore, 50);
  }

  return finalize(envelope, {
    decision: state.decision,
    reason: state.reason,
    risk: { level: riskLevelForScore(Math.min(100, state.riskScore), RISK_LEVELS), score: Math.min(100, state.riskScore) },
    findings,
  }, options);
}

module.exports = {
  EXTERNAL_ACTION_DECISIONS,
  EXTERNAL_ACTION_REASONS,
  evaluateExternalAction,
  recordExternalActionOutcome,
  recordExternalActionReview,
  mergeExternalActionDecisions: mergeDecision,
  normalizeExternalActionFindingRiskScore: normalizeScore,
  SHELL_SIDE_EFFECT_RULES,
};
