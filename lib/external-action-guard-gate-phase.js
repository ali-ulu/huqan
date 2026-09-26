'use strict';

// The guard's gate phase (#2173): AB1 classification, then the kind-specific
// gates (AB2, shell side effects + AB8, AB4, AB5, egress AB9/AB12/AB13, AB11)
// over an envelope that already passed identity, malformed and boundary
// checks. Mutates the caller's `state` and `findings` in place.

const { classifyAgentAction, RISK_LEVELS } = require('./action-risk-classifier');
const { evaluateToolCall } = require('./tool-call-gate');
const { evaluateCommandExec } = require('./command-exec-gate');
const { evaluateMemoryMutation } = require('./memory-mutation-gate');
const { evaluateAutomationSafety } = require('./automation-safety-gate');
const { evaluateExternalActionEgress } = require('./external-action-egress-gates');
const { evaluateCrossWorkspaceAccess } = require('./cross-workspace-access-gate');
const { EXTERNAL_ACTION_KINDS } = require('./external-action-envelope');
const { actionDecision, buildAb1Input, classifierForToolGate, mergeDecision, recordGateError, runGate, scoreForLevel } = require('./external-action-guard-gates');
const { EXTERNAL_ACTION_DECISIONS, EXTERNAL_ACTION_REASONS, SHELL_SIDE_EFFECT_RULES } = require('./external-action-guard-rules');

function evaluateGatePhase(envelope, options, findings, state) {
  let ab1;
  try {
    ab1 = classifyAgentAction(buildAb1Input(envelope));
    const projected = actionDecision(ab1.decision);
    findings.push({ gate: 'AB1', decision: projected, reason: ab1.reason, riskLevel: ab1.riskLevel, flags: ab1.flags || [] });
    state.decision = mergeDecision(state.decision, projected);
    state.riskLevel = ab1.riskLevel || state.riskLevel;
    state.riskScore = Math.max(state.riskScore, scoreForLevel(state.riskLevel));
  } catch (error) {
    state.decision = mergeDecision(state.decision, recordGateError('AB1', error, findings));
    state.reason = EXTERNAL_ACTION_REASONS.GATE_ERROR;
    state.riskLevel = RISK_LEVELS.CRITICAL;
    state.riskScore = 100;
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
    state.decision = mergeDecision(state.decision, ab2Decision);
  }

  if (envelope.kind === EXTERNAL_ACTION_KINDS.SHELL) {
    for (const rule of SHELL_SIDE_EFFECT_RULES) {
      if (!rule.pattern.test(envelope.command)) continue;
      findings.push({ gate: 'shell-side-effect', decision: rule.decision, reason: rule.reason });
      state.decision = mergeDecision(state.decision, rule.decision);
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
    state.decision = mergeDecision(state.decision, ab8Decision);
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
    state.decision = mergeDecision(state.decision, ab4Decision);
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
    state.decision = mergeDecision(state.decision, ab5Decision);
  }

  // AB9 / AB12 / AB13 live in lib/external-action-egress-gates.js (#2505).
  const egress = evaluateExternalActionEgress({ envelope, options, findings, runGate, blockDecision: EXTERNAL_ACTION_DECISIONS.BLOCK });
  for (const egressDecision of egress.decisions) state.decision = mergeDecision(state.decision, egressDecision);
  if (egress.residencyBlocked) {
    // The reason is left to the generic path, which reports the blocking
    // gate's own `data_residency_violation` -- more use to a compliance
    // reader than a second, blunter constant naming only the guard. The risk
    // level is set here because a cross-border transfer of personal data is
    // critical whatever the command's own classification said.
    state.riskLevel = RISK_LEVELS.CRITICAL;
    state.riskScore = 100;
  }

  if (envelope.targetWorkspaceId && envelope.targetWorkspaceId !== envelope.workspaceId) {
    const ab11Decision = runGate('AB11', findings, () => evaluateCrossWorkspaceAccess({
      actorWorkspaceId: envelope.workspaceId,
      targetWorkspaceId: envelope.targetWorkspaceId,
      operation: envelope.action,
      grants: envelope.workspaceGrants,
      resourceType: envelope.kind,
    }), result => ({ decision: result.decision, reason: result.reason, crossWorkspace: result.crossWorkspace }));
    state.decision = mergeDecision(state.decision, ab11Decision);
  }
}

module.exports = { evaluateGatePhase };
