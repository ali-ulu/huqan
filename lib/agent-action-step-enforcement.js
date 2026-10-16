'use strict';

// Agent step enforcement, moved verbatim from lib/agent-action-firewall.js
// (#2197): apply a firewall decision to one agent step, with telemetry on
// non-allow. The receiver-owned internal-action capability marks calls the
// receiver itself issued. Callers require this module directly; the facade
// (lib/agent-action-firewall.js) does not re-export it, which keeps the
// dependency direction acyclic (enforcement -> facade, never back).

const { emitGateTelemetry } = require('./gate-telemetry');
const { AGENT_ACTION_FIREWALL_DECISIONS, INTERNAL_ACTION_CAPABILITY } = require('./agent-action-signals');
const { evaluateAgentActionFirewall } = require('./agent-action-firewall');
const { firewallError } = require('./agent-action-decisions');

function createReceiverOwnedInternalActionRequest(request = {}) {
  const trustedRequest = { ...request };
  Object.defineProperty(trustedRequest, INTERNAL_ACTION_CAPABILITY, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return trustedRequest;
}

function enforceAgentActionStep({ step, state, opts = {}, kernel, allowedTools }) {
  const firewallDecision = evaluateAgentActionFirewall({
    surface: 'agent',
    tool: step.tool,
    action: step.action,
    input: step.input,
    context: {
      goal: state.goal,
      objective: state.objective,
      action: step.action,
      goalIntegrity: state.plan?.goalIntegrity || null,
      workspaceId: state.workspaceId || opts.workspaceId || 'default',
      actor: opts.actor || 'agent',
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      repoState: opts.repoState,
    },
    approval: opts.agentActionApproval,
    preview: opts.preview === true,
    dryRun: opts.dryRun === true,
  });
  const structuredAction = Boolean(step.input && typeof step.input === 'object' && !Array.isArray(step.input)
    && ['action', 'operation', 'operationType', 'intent', 'command', 'cmd', 'shell', 'script', 'exec']
      .some(key => Object.prototype.hasOwnProperty.call(step.input, key)));
  const enforceFirewall = firewallDecision.decision === AGENT_ACTION_FIREWALL_DECISIONS.BLOCK
    || allowedTools.has(step.tool)
    || structuredAction;
  if (enforceFirewall && firewallDecision.decision !== AGENT_ACTION_FIREWALL_DECISIONS.ALLOW) {
    emitGateTelemetry(kernel, 'agent-action-firewall', {
      decision: firewallDecision.decision,
      reason: firewallDecision.reason,
      metadata: firewallDecision.metadata,
      findings: firewallDecision.findings,
    });
  }
  if (!enforceFirewall || firewallDecision.decision === AGENT_ACTION_FIREWALL_DECISIONS.ALLOW) {
    return { firewallDecision, result: null };
  }

  return {
    firewallDecision,
    result: {
      ok: false,
      type: 'agent',
      data: null,
      evidence: [],
      error: {
        code: firewallError(firewallDecision.decision),
        message: firewallDecision.reason || 'Agent action was stopped by the action firewall.',
      },
      meta: {
        blocked: true,
        firewall: firewallDecision,
        firewallVersion: firewallDecision.metadata?.firewallVersion || null,
      },
    },
  };
}

module.exports = {
  createReceiverOwnedInternalActionRequest,
  enforceAgentActionStep,
};
