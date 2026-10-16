'use strict';

// Agent action decision constructors, moved verbatim from
// lib/agent-action-firewall.js (#2197): metadata attachment plus the
// allow/block verdict builders and the decision-to-error-code map.
// Depends only on the automation gate and the signals leaf below it.

const { normalizeAutomationSafetyDecision } = require('./automation-safety-gate');
const { AUTOMATION_SAFETY_POLICY_VERSION } = require('./automation-safety-gate/automation-safety-vocabulary');
const { AGENT_ACTION_FIREWALL_DECISIONS } = require('./agent-action-signals');

function attachFirewallMetadata(decision, metadata, extras = {}) {
  return {
    ...decision,
    metadata: {
      ...(decision && decision.metadata ? decision.metadata : {}),
      ...metadata,
      ...extras,
    },
  };
}

function safeAllowDecision(metadata, reason = 'AGENT_READ_ONLY_ACTION_ALLOWED') {
  return attachFirewallMetadata(normalizeAutomationSafetyDecision({
    ok: true,
    decision: AGENT_ACTION_FIREWALL_DECISIONS.ALLOW,
    reason,
    risk: { level: 'low', score: 0.05, categories: ['agent-read-only'] },
    findings: [{
      id: 'agent-read-only',
      operationType: metadata.action || metadata.tool,
      target: metadata.tool,
      actor: 'agent',
      category: 'agent-read-only',
      riskLevel: 'low',
      riskScore: 0.05,
      decision: AGENT_ACTION_FIREWALL_DECISIONS.ALLOW,
      reason,
      notes: ['Read-only agent action does not execute an external automation mutation.'],
      sensitive: false,
      explicitApproval: false,
      previewRequested: false,
    }],
    metadata: {
      policyVersion: AUTOMATION_SAFETY_POLICY_VERSION,
      workspaceId: metadata.workspaceId,
      ...metadata,
    },
  }), metadata);
}

function malformedDecision(metadata, reason = 'AGENT_ACTION_MALFORMED_INPUT') {
  return attachFirewallMetadata(normalizeAutomationSafetyDecision({
    ok: false,
    decision: AGENT_ACTION_FIREWALL_DECISIONS.BLOCK,
    reason,
    risk: { level: 'critical', score: 1, categories: ['agent-action-firewall'] },
    findings: [{
      id: 'agent-action-firewall-malformed',
      operationType: metadata.action || metadata.tool || 'unknown',
      target: metadata.tool,
      actor: 'agent',
      category: 'malformed-agent-action',
      riskLevel: 'critical',
      riskScore: 1,
      decision: AGENT_ACTION_FIREWALL_DECISIONS.BLOCK,
      reason,
      notes: ['The firewall could not safely normalize the action.'],
      sensitive: false,
      explicitApproval: false,
      previewRequested: false,
    }],
    metadata: {
      policyVersion: AUTOMATION_SAFETY_POLICY_VERSION,
      workspaceId: metadata.workspaceId,
      ...metadata,
    },
  }), metadata);
}

function firewallError(decision) {
  if (decision === AGENT_ACTION_FIREWALL_DECISIONS.BLOCK) return 'AGENT_ACTION_BLOCKED';
  if (decision === AGENT_ACTION_FIREWALL_DECISIONS.DRY_RUN_ONLY) return 'AGENT_ACTION_DRY_RUN_ONLY';
  return 'AGENT_ACTION_REVIEW_REQUIRED';
}

module.exports = {
  attachFirewallMetadata,
  firewallError,
  malformedDecision,
  safeAllowDecision,
};
