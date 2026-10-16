'use strict';

// The delegated-policy side of the A2A exchange: the policy an exchange may
// act under, the agent-action firewall call and the receipt metadata it
// leaves. Moved out of exchange-route.js (#2185).

const { A2A_FIREWALL_POLICY_MISSING, CANONICAL_WORKSPACE } = require('./exchange-route-contract');

function resolveDelegatedPolicy(request, authority) {
  const sourceRef = String(request?.source?.identityRef || '');
  const source = Array.isArray(authority?.identities)
    ? authority.identities.find((entry) => entry && entry.ref === sourceRef)
    : null;
  const policyVersion = String(source?.record?.policy_version || '').trim();
  const constraints = request?.constraints;
  if (!policyVersion || !constraints || !Array.isArray(constraints.allowedTools)
      || !Array.isArray(constraints.allowedConnectors)) return null;
  return Object.freeze({
    policyVersion,
    workspaceId: String(request.workspaceId || ''),
    maxRiskTier: String(constraints.maxRiskTier || ''),
    allowedTools: Object.freeze([...constraints.allowedTools]),
    allowedConnectors: Object.freeze([...constraints.allowedConnectors]),
  });
}

function missingPolicyDecision(request) {
  return {
    ok: false,
    allowed: false,
    canExecute: false,
    canDryRun: false,
    decision: 'block',
    reason: A2A_FIREWALL_POLICY_MISSING,
    risk: { level: 'critical', score: 1, categories: ['a2a-policy'] },
    requiredReview: true,
    dryRunOnly: false,
    findings: [],
    warnings: [],
    metadata: {
      workspaceId: String(request?.workspaceId || CANONICAL_WORKSPACE),
      surface: 'a2a',
    },
  };
}

function evaluateA2aAgentActionFirewall(request, authority, evaluateAgentActionFirewall) {
  const policy = resolveDelegatedPolicy(request, authority);
  if (!policy) return missingPolicyDecision(request);
  const task = request.requestedAction;
  return evaluateAgentActionFirewall({
    surface: 'a2a',
    tool: task.tool,
    action: task.capability,
    input: {
      operationType: task.capability,
      action: task.capability,
      target: task.target,
      connector: task.connector,
      parametersHash: task.parametersHash,
      task,
      policy,
    },
    context: {
      workspaceId: request.workspaceId,
      actor: `agent:${request.source.agentId}`,
      target: task.target,
    },
    policyOverride: policy,
  });
}

function buildFirewallReceiptMetadata(request, decision, authority, aggregation = null) {
  const policy = resolveDelegatedPolicy(request, authority);
  const metadata = decision && typeof decision.metadata === 'object' ? decision.metadata : {};
  return Object.freeze({
    decision: String(decision?.decision || 'block'),
    reason: String(decision?.reason || 'AGENT_ACTION_FIREWALL_EVALUATION_FAILED'),
    firewallVersion: String(metadata.firewallVersion || ''),
    policyVersion: String(metadata.policyVersion || policy?.policyVersion || ''),
    actionId: String(metadata.actionId || ''),
    workspaceId: String(request?.workspaceId || CANONICAL_WORKSPACE),
    sourceAgentId: String(request?.source?.agentId || ''),
    targetAgentId: String(request?.target?.agentId || ''),
    task: request?.requestedAction || null,
    policy,
    routeReceipt: request?.routeReceipt || null,
    crossAgentAggregation: aggregation,
  });
}

module.exports = Object.freeze({ buildFirewallReceiptMetadata, evaluateA2aAgentActionFirewall });
