'use strict';

const { canonicalizeGitHubRepoUrl } = require('../github-url');
const { executeConnectorAction } = require('../connector-action-firewall');

function connectorFirewallIsEnabled(input = {}) {
  return input.enforceConnectorFirewall === true || input.connectorFirewall?.enabled === true;
}

function connectorFirewallFailure(guarded, sourceType) {
  const normalizationFailure = new Set([
    'CONNECTOR_TARGET_REQUIRED',
    'CONNECTOR_TARGET_INVALID',
    'CONNECTOR_ACTION_UNKNOWN',
  ]).has(guarded.reason);
  return {
    ok: false,
    sourceType,
    error: guarded.error || guarded.reason || 'Connector action blocked',
    code: normalizationFailure ? guarded.reason : (guarded.code || 'CONNECTOR_ACTION_FIREWALL_BLOCKED'),
    connectorFirewall: guarded.firewallSummary || {
      decision: guarded.decision || null,
      reason: guarded.reason || null,
      connectorFirewallVersion: guarded.connectorFirewallVersion || null,
    },
  };
}

async function executeGuardedConnectorIngest({ connector, target, input = {}, execute }) {
  if (!connectorFirewallIsEnabled(input)) {
    return { ok: true, value: await execute() };
  }

  const request = {
    connector,
    action: 'ingest',
    workspaceId: input.workspaceId,
    actor: input.actor,
    preview: input.preview === true,
    dryRun: input.dryRun === true,
    approval: input.connectorFirewall?.approval || input.agentActionApproval,
  };
  if (connector === 'http') request.urls = Array.isArray(target) ? target : [target];
  else request.targetPath = target;

  const guarded = await executeConnectorAction({
    request,
    execute,
  });
  if (!guarded.ok) return connectorFirewallFailure(guarded, connector);
  return {
    ok: true,
    value: guarded.value,
    connectorFirewall: guarded.firewallSummary || null,
  };
}


async function fetchGithubRepoWithFirewall({ rawRepoUrl, input = {}, fetchRepoFilesImpl, fetchOptions }) {
  if (!connectorFirewallIsEnabled(input)) {
    const repoUrl = canonicalizeGitHubRepoUrl(rawRepoUrl).repoUrl;
    return { ok: true, repoUrl, value: await fetchRepoFilesImpl(repoUrl, fetchOptions) };
  }
  let repoUrl;
  const guarded = await executeConnectorAction({
    request: {
      connector: 'github',
      action: 'ingest',
      repoUrl: rawRepoUrl,
      branch: fetchOptions.branch,
      workspaceId: input.workspaceId,
      actor: input.actor,
      preview: input.preview === true,
      dryRun: input.dryRun === true,
      approval: input.connectorFirewall?.approval || input.agentActionApproval,
    },
    execute: decision => fetchRepoFilesImpl(repoUrl, fetchOptions, decision),
  });
  const connectorFirewall = guarded.firewallSummary || {
    decision: guarded.decision || null,
    reason: guarded.reason || null,
    connectorFirewallVersion: guarded.connectorFirewallVersion || null,
  };
  if (!guarded.ok) {
    const normalizationFailure = new Set([
      'CONNECTOR_TARGET_REQUIRED',
      'CONNECTOR_TARGET_INVALID',
      'CONNECTOR_ACTION_UNKNOWN',
    ]).has(guarded.reason);
    return {
      ok: false,
      sourceType: 'github',
      repoUrl,
      error: guarded.error || guarded.reason || 'Connector action blocked',
      code: normalizationFailure ? guarded.reason : (guarded.code || 'CONNECTOR_ACTION_FIREWALL_BLOCKED'),
      connectorFirewall,
    };
  }
  return { ok: true, repoUrl: guarded.target, value: guarded.value, connectorFirewall };
}

module.exports = {
  executeGuardedConnectorIngest,
  fetchGithubRepoWithFirewall,
};
