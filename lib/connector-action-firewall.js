'use strict';

// The connector action firewall: evaluates a connector request against its
// declared contract, and runs the executor only for an allowed decision.
// Contracts, normalization and summaries live in connector-action-firewall-*.js (#2190).

const { AGENT_ACTION_FIREWALL_VERSION, AGENT_ACTION_FIREWALL_DECISIONS, evaluateAgentActionFirewall } = require('./agent-action-firewall');
const { CONNECTOR_ACTIONS, CONNECTOR_ACTION_COVERAGE, CONNECTOR_ACTION_FIREWALL_VERSION } = require('./connector-action-firewall-contracts');
const { malformedConnectorDecision, normalizeConnectorAction, text } = require('./connector-action-firewall-normalize');
const { summarizeFirewall } = require('./connector-action-firewall-summary');

function evaluateConnectorAction(request = {}) {
  const normalized = normalizeConnectorAction(request);
  if (!normalized.ok) return normalized;

  const firewall = evaluateAgentActionFirewall({
    surface: 'connector',
    tool: `connector:${normalized.connector}`,
    action: normalized.firewallAction,
    input: {
      action: normalized.firewallAction,
      operationType: normalized.firewallAction,
      target: normalized.target,
      branch: normalized.branch,
    },
    context: {
      target: normalized.target,
      branch: normalized.branch,
      actor: normalized.actor,
      workspaceId: normalized.workspaceId,
    },
    approval: normalized.approval,
    preview: normalized.preview,
    dryRun: normalized.dryRun,
  });

  const previewOnly = normalized.preview || normalized.dryRun;
  const canExecute = firewall.decision === AGENT_ACTION_FIREWALL_DECISIONS.ALLOW && !previewOnly;
  return {
    ...normalized,
    ok: true,
    canExecute,
    decision: previewOnly
      ? AGENT_ACTION_FIREWALL_DECISIONS.DRY_RUN_ONLY
      : firewall.decision,
    reason: previewOnly ? 'CONNECTOR_PREVIEW_ONLY' : firewall.reason,
    connectorFirewallVersion: CONNECTOR_ACTION_FIREWALL_VERSION,
    firewallVersion: AGENT_ACTION_FIREWALL_VERSION,
    firewall,
    firewallSummary: summarizeFirewall(firewall, {
      egressClass: normalized.egressClass,
      budget: normalized.budget,
    }),
  };
}

async function executeConnectorAction({ request = {}, execute } = {}) {
  // An evaluator that throws must produce a refusal, not an exception. The
  // request is caller-shaped, so a throwing getter on it -- or any future
  // failure inside normalization -- used to propagate out of here, and callers
  // that wrap this in their own try/catch (plugins/evidence-validator.js does)
  // would score it against whatever their catch block was written for rather
  // than as a firewall decision. The executor was never reached on that path;
  // what was missing was the decision saying so.
  let decision;
  try {
    decision = evaluateConnectorAction(request);
  } catch (error) {
    return {
      ...malformedConnectorDecision({ reason: 'CONNECTOR_EVALUATION_FAILED' }),
      code: 'CONNECTOR_ACTION_FIREWALL_BLOCKED',
      error: text(error?.message || error, 'Connector evaluation failed', 240),
    };
  }
  if (typeof execute !== 'function') {
    return {
      ...decision,
      ok: false,
      code: 'CONNECTOR_EXECUTOR_MISSING',
      canExecute: false,
    };
  }
  if (!decision.ok || !decision.canExecute) {
    return {
      ...decision,
      ok: false,
      code: 'CONNECTOR_ACTION_FIREWALL_BLOCKED',
      canExecute: false,
    };
  }

  try {
    const value = await execute(decision);
    return {
      ...decision,
      ok: true,
      value,
    };
  } catch (error) {
    return {
      ...decision,
      ok: false,
      code: error?.code || 'CONNECTOR_EXECUTION_FAILED',
      error: text(error?.message || error, 'Connector execution failed', 240),
      canExecute: false,
    };
  }
}

module.exports = {
  CONNECTOR_ACTION_FIREWALL_VERSION,
  CONNECTOR_ACTIONS,
  CONNECTOR_ACTION_COVERAGE,
  normalizeConnectorAction,
  evaluateConnectorAction,
  executeConnectorAction,
};
