'use strict';

// #2190: the bounded summaries of a connector policy and a firewall result.

const { AGENT_ACTION_FIREWALL_VERSION } = require('./agent-action-firewall');
const { text } = require('./connector-action-firewall-normalize');

function summarizeConnectorPolicy(policy) {
  if (!policy || typeof policy !== 'object') return null;
  const budget = policy.budget;
  if (!budget || typeof budget !== 'object') return null;
  return {
    egressClass: text(policy.egressClass, '', 64),
    budget: {
      class: text(budget.class, '', 64),
      targetCount: Number.isInteger(budget.targetCount) ? budget.targetCount : null,
      costPerTarget: Number.isFinite(budget.costPerTarget) ? budget.costPerTarget : null,
      costUnits: Number.isFinite(budget.costUnits) ? budget.costUnits : null,
      maxTargets: Number.isInteger(budget.maxTargets) ? budget.maxTargets : null,
      maxCostUnits: Number.isFinite(budget.maxCostUnits) ? budget.maxCostUnits : null,
    },
  };
}

function summarizeFirewall(firewall, connectorPolicy = null) {
  if (!firewall || typeof firewall !== 'object') return null;
  return {
    decision: firewall.decision || null,
    reason: text(firewall.reason, '', 240),
    risk: firewall.risk && typeof firewall.risk === 'object'
      ? {
        level: text(firewall.risk.level, '', 32),
        score: Number.isFinite(firewall.risk.score) ? firewall.risk.score : null,
        categories: Array.isArray(firewall.risk.categories)
          ? firewall.risk.categories.map(value => text(value, '', 64)).filter(Boolean).slice(0, 8)
          : [],
      }
      : null,
    connectorPolicy: summarizeConnectorPolicy(connectorPolicy),
    metadata: firewall.metadata && typeof firewall.metadata === 'object'
      ? {
        actionId: text(firewall.metadata.actionId, '', 64),
        surface: text(firewall.metadata.surface, '', 32),
        tool: text(firewall.metadata.tool, '', 64),
        action: text(firewall.metadata.action, '', 96),
        workspaceId: text(firewall.metadata.workspaceId, 'default', 128),
        firewallVersion: text(firewall.metadata.firewallVersion, AGENT_ACTION_FIREWALL_VERSION, 32),
      }
      : null,
  };
}

module.exports = {
  summarizeFirewall,
};
