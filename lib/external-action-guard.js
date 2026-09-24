'use strict';

// The external action guard: evaluates one normalized external action through
// every applicable gate and returns the merged, finalized decision. Rules,
// gate helpers, finalization and outcome records live in
// external-action-guard-*.js (#2173).

const { classifyAgentAction, RISK_LEVELS } = require('./action-risk-classifier');
const { evaluateToolCall } = require('./tool-call-gate');
const { evaluateCommandExec } = require('./command-exec-gate');
const { evaluateMemoryMutation } = require('./memory-mutation-gate');
const { evaluateAutomationSafety } = require('./automation-safety-gate');
const { evaluateExternalActionEgress } = require('./external-action-egress-gates');
const { evaluateCrossWorkspaceAccess } = require('./cross-workspace-access-gate');
const { riskLevelForScore } = require('./risk-scale');
const { resolvePathWithinRoot } = require('./path-safety');
const { isControlPlanePath, findControlPlaneCommandTarget } = require('./control-plane-paths');
const { normalizeExternalActionEnvelope, EXTERNAL_ACTION_KINDS } = require('./external-action-envelope');
const { evaluateAgentIdentity } = require('./external-action-identity');
const { privilegeEscalationOptions, evaluateIdentityEscalation } = require('./identity-privilege-escalation');
const { evaluateGraduatedAutonomy, graduatedAutonomyOptions } = require('./graduated-autonomy');
const { summarizeSessionImpact } = require('./session-impact');
const { postActionMonitoringOptions } = require('./post-action-monitor');
const { actionDecision, buildAb1Input, classifierForToolGate, finalize, genericDecision, mergeDecision, normalizeScore, recordGateError, runGate, scoreForLevel } = require('./external-action-guard-gates');
const { recordExternalActionOutcome, recordExternalActionReview } = require('./external-action-guard-records');
const { EXTERNAL_ACTION_DECISIONS, EXTERNAL_ACTION_REASONS, SHELL_SIDE_EFFECT_RULES } = require('./external-action-guard-rules');

function evaluateExternalAction(input, options = {}) {
  const envelope = normalizeExternalActionEnvelope(input, options);
  const continuousMonitoring = postActionMonitoringOptions(options);
  const findings = [];
  let decision = EXTERNAL_ACTION_DECISIONS.ALLOW;
  let reason = EXTERNAL_ACTION_REASONS.ALLOWED;
  let riskLevel = RISK_LEVELS.LOW;
  let riskScore = 10;

  // Identity runs first and unconditionally: even a malformed envelope or a
  // rejected card leaves a persisted identity on the receipt, so the audit
  // trail never has an action without an answer to "who did this".
  const identity = evaluateAgentIdentity(envelope, options);
  envelope.identity = identity.identity;
  findings.push(identity.finding);
  decision = mergeDecision(decision, genericDecision(identity.finding.decision));
  if (decision !== EXTERNAL_ACTION_DECISIONS.ALLOW) reason = identity.finding.reason;

  // #1891: the identity gate above is memoryless. This asks what needs a
  // session's memory: has this identity's claimed authority grown since the
  // session began? On by default since #2157; a deployment can opt out.
  const escalationConfig = privilegeEscalationOptions(options);
  if (escalationConfig) {
    const escalation = evaluateIdentityEscalation({ envelope, identity: identity.identity }, escalationConfig);
    if (escalation) {
      findings.push(escalation);
      const before = decision;
      decision = mergeDecision(decision, genericDecision(escalation.decision));
      if (decision !== before) reason = escalation.reason;
    }
  }

  // Graduated autonomy (on by default since #2157) is a ceiling over AB1-AB11:
  // it may require review above the identity's tier, never relax a stricter one.
  try {
    const autonomyOptions = graduatedAutonomyOptions(continuousMonitoring && !options.graduatedAutonomy
      ? {
          ...options,
          graduatedAutonomy: {
            enabled: true,
            receipts: continuousMonitoring.receipts,
            receiptPath: continuousMonitoring.receiptPath,
            activation: continuousMonitoring.activation,
          },
        }
      : options);
    if (autonomyOptions) {
      const autonomy = evaluateGraduatedAutonomy({
        identity: envelope.identity,
        action: { kind: envelope.kind, riskCategory: envelope.riskCategory },
        receipts: autonomyOptions.receipts,
        activation: autonomyOptions.activation,
      }, { now: autonomyOptions.now });
      envelope.autonomy = autonomy.autonomy;
      envelope.sessionImpact = summarizeSessionImpact(autonomyOptions.receipts, envelope.session.id, { sandboxEscapes: options.sandboxEscapes });
      findings.push(autonomy.finding);
      decision = mergeDecision(decision, genericDecision(autonomy.decision));
      if (autonomy.decision !== EXTERNAL_ACTION_DECISIONS.ALLOW) reason = autonomy.reason;
    }
  } catch (error) {
    decision = mergeDecision(decision, recordGateError('graduated-autonomy', error, findings));
    reason = EXTERNAL_ACTION_REASONS.GATE_ERROR;
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = 100;
  }

  if (envelope.malformed) {
    decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
    reason = EXTERNAL_ACTION_REASONS.MALFORMED;
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = 100;
    findings.push({ gate: 'envelope', decision, reason, flags: envelope.errors });
    return finalize(envelope, { decision, reason, risk: { level: riskLevel, score: riskScore }, findings }, options);
  }

  if ([EXTERNAL_ACTION_KINDS.FILE_READ, EXTERNAL_ACTION_KINDS.FILE_WRITE].includes(envelope.kind)
      && envelope.target.path) {
    const absoluteTarget = require('node:path').resolve(envelope.cwd, envelope.target.path);
    try {
      resolvePathWithinRoot(envelope.workspaceRoot, absoluteTarget, { allowMissing: true });
    } catch (_) {
      decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
      reason = EXTERNAL_ACTION_REASONS.OUTSIDE_WORKSPACE;
      riskLevel = RISK_LEVELS.CRITICAL;
      riskScore = 100;
      findings.push({ gate: 'path-safety', decision, reason });
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
      decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
      reason = EXTERNAL_ACTION_REASONS.CONTROL_PLANE;
      riskLevel = RISK_LEVELS.CRITICAL;
      riskScore = 100;
      findings.push({ gate: 'control-plane', decision, reason, profile: controlPlane.profile, path: controlPlane.path });
    }
  }

  let ab1;
  try {
    ab1 = classifyAgentAction(buildAb1Input(envelope));
    const projected = actionDecision(ab1.decision);
    findings.push({ gate: 'AB1', decision: projected, reason: ab1.reason, riskLevel: ab1.riskLevel, flags: ab1.flags || [] });
    decision = mergeDecision(decision, projected);
    riskLevel = ab1.riskLevel || riskLevel;
    riskScore = Math.max(riskScore, scoreForLevel(riskLevel));
  } catch (error) {
    decision = mergeDecision(decision, recordGateError('AB1', error, findings));
    reason = EXTERNAL_ACTION_REASONS.GATE_ERROR;
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = 100;
  }

  // Shell invocations are classified by AB1 and then parsed by the shell-aware
  // AB8 gate below. Passing generic shell tool names (Bash, terminal, exec)
  // through AB2 as well would turn even AB8-allowlisted read commands into an
  // "unknown tool" review, making adapter spelling affect policy.
  if (ab1 && envelope.kind !== EXTERNAL_ACTION_KINDS.SHELL) {
    const ab2Decision = runGate('AB2', findings, () => evaluateToolCall({
      toolName: envelope.tool.name,
      action: envelope.action,
      args: envelope.args,
      workspaceId: envelope.workspaceId,
      classifier: classifierForToolGate(ab1),
    }), result => ({ decision: result.decision, reason: result.reason, riskLevel: result.risk?.level }));
    decision = mergeDecision(decision, ab2Decision);
  }

  if (envelope.kind === EXTERNAL_ACTION_KINDS.SHELL) {
    for (const rule of SHELL_SIDE_EFFECT_RULES) {
      if (!rule.pattern.test(envelope.command)) continue;
      findings.push({ gate: 'shell-side-effect', decision: rule.decision, reason: rule.reason });
      decision = mergeDecision(decision, rule.decision);
    }
    const ab8Decision = runGate('AB8', findings, () => evaluateCommandExec({
      command: envelope.command,
      cwd: envelope.cwd,
      workspaceRoot: envelope.workspaceRoot,
    }), result => ({
      decision: result.decision,
      reason: result.reason,
      denylistMatch: result.denylistMatch,
      injectionMatches: result.injectionMatches,
    }));
    decision = mergeDecision(decision, ab8Decision);
  }

  if (envelope.kind === EXTERNAL_ACTION_KINDS.MEMORY) {
    const entries = Array.isArray(envelope.args.entries) && envelope.args.entries.length
      ? envelope.args.entries
      : [{
          id: `external-${envelope.invocationId}`,
          action: envelope.action,
          changeType: 'content',
          scope: envelope.workspaceId,
          workspaceId: envelope.workspaceId,
          content: envelope.args.text || '',
        }];
    const ab4Decision = runGate('AB4', findings, () => evaluateMemoryMutation({
      entries,
      operationType: envelope.action,
      mutationType: 'graph',
      targetSpace: envelope.targetWorkspaceId || envelope.workspaceId,
    }), result => ({ decision: result.decision, reason: result.reason, riskLevel: result.risk?.level }));
    decision = mergeDecision(decision, ab4Decision);
  }

  if ([EXTERNAL_ACTION_KINDS.AUTOMATION, EXTERNAL_ACTION_KINDS.DEPLOYMENT].includes(envelope.kind)) {
    const ab5Decision = runGate('AB5', findings, () => evaluateAutomationSafety({
      operation: { action: envelope.action, operationType: envelope.action, target: envelope.tool.name },
      operationType: envelope.action,
      target: envelope.tool.name,
      actor: envelope.agent.name,
      preview: false,
      dryRun: false,
      metadata: { source: 'external-action-guard' },
    }), result => ({ decision: result.decision, reason: result.reason, riskLevel: result.risk?.level }));
    decision = mergeDecision(decision, ab5Decision);
  }

  // AB9 / AB12 / AB13 live in lib/external-action-egress-gates.js (#2505).
  const egress = evaluateExternalActionEgress({ envelope, options, findings, runGate, blockDecision: EXTERNAL_ACTION_DECISIONS.BLOCK });
  for (const egressDecision of egress.decisions) decision = mergeDecision(decision, egressDecision);
  if (egress.residencyBlocked) {
    // The reason is left to the generic path, which reports the blocking
    // gate's own `data_residency_violation` -- more use to a compliance
    // reader than a second, blunter constant naming only the guard. The risk
    // level is set here because a cross-border transfer of personal data is
    // critical whatever the command's own classification said.
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = 100;
  }

  if (envelope.targetWorkspaceId && envelope.targetWorkspaceId !== envelope.workspaceId) {
    const ab11Decision = runGate('AB11', findings, () => evaluateCrossWorkspaceAccess({
      actorWorkspaceId: envelope.workspaceId,
      targetWorkspaceId: envelope.targetWorkspaceId,
      operation: envelope.action,
      grants: envelope.workspaceGrants,
      resourceType: envelope.kind,
    }), result => ({ decision: result.decision, reason: result.reason, crossWorkspace: result.crossWorkspace }));
    decision = mergeDecision(decision, ab11Decision);
  }

  for (const finding of findings) {
    riskScore = Math.max(riskScore, normalizeScore(finding));
  }
  if (decision === EXTERNAL_ACTION_DECISIONS.BLOCK) {
    reason = findings.findLast(finding => finding.decision === 'block')?.reason || EXTERNAL_ACTION_REASONS.BLOCKED;
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = Math.max(riskScore, 95);
  } else if (decision === EXTERNAL_ACTION_DECISIONS.REVIEW) {
    reason = EXTERNAL_ACTION_REASONS.REVIEW;
    riskScore = Math.max(riskScore, 50);
  }

  return finalize(envelope, {
    decision,
    reason,
    risk: { level: riskLevelForScore(Math.min(100, riskScore), RISK_LEVELS), score: Math.min(100, riskScore) },
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
