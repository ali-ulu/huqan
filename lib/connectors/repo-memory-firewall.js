'use strict';

const { executeConnectorAction } = require('../connector-action-firewall');

/**
 * Every connector execution below goes through `executeConnectorAction`.
 *
 * It did not always. `connectorFirewallIsEnabled(input)` used to gate both
 * wrappers on `enforceConnectorFirewall === true` or
 * `connectorFirewall.enabled === true`, and neither is set by any caller in
 * this repository. The firewall was therefore off for every production ingest,
 * and the "guarded" wrappers called the executor directly:
 *
 *     if (!connectorFirewallIsEnabled(input)) {
 *       return { ok: true, value: await execute() };   // no firewall at all
 *     }
 *
 * That is the gap #1010 names: the wrapper existing is not the same as every
 * path traversing it. An opt-in control that nothing opts into is a control on
 * paper.
 *
 * Removing the branch costs nothing a caller wanted. All seven connector
 * ingests -- github, markdown, json, yaml, git-log, pdf, http -- evaluate to
 * `allow / LOW_RISK_READ_ONLY` on ordinary targets; what the firewall refuses
 * is the malformed and the credential-bearing, which no legitimate ingest
 * sends. `preview` and `dryRun` remain the way a caller asks not to execute,
 * and they travel in the request rather than around the wrapper.
 */

function connectorFirewallFailure(guarded, sourceType) {
  // Keep the public path-error contract when layer 2 catches the escape
  // before an adapter does. The firewall envelope still identifies the gate.
  const pathCode = guarded.reason === 'CONNECTOR_PATH_OUTSIDE_ROOT'
    ? 'PATH_OUTSIDE_ALLOWED_ROOT' : null;
  const normalizationFailure = new Set([
    'CONNECTOR_TARGET_REQUIRED',
    'CONNECTOR_TARGET_INVALID',
    'CONNECTOR_ACTION_UNKNOWN',
  ]).has(guarded.reason);
  return {
    ok: false,
    sourceType,
    error: guarded.error || guarded.reason || 'Connector action blocked',
    code: pathCode || (normalizationFailure ? guarded.reason : (guarded.code || 'CONNECTOR_ACTION_FIREWALL_BLOCKED')),
    connectorFirewall: guarded.firewallSummary || {
      decision: guarded.decision || null,
      reason: guarded.reason || null,
      connectorFirewallVersion: guarded.connectorFirewallVersion || null,
    },
  };
}

async function executeGuardedConnectorIngest({ connector, target, rootPath, input = {}, execute }) {
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
  else {
    request.targetPath = target;
    request.rootPath = rootPath;
  }

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
  // `decision.target` is the canonicalized repository URL the firewall just
  // judged, so the fetch runs against exactly what was allowed. It used to read
  // a `let repoUrl;` that nothing ever assigned on this branch -- harmless only
  // because the branch was unreachable while the firewall was opt-in, and a
  // `fetchRepoFilesImpl(undefined, …)` the moment it was not. Reading the target
  // back off the decision also removes the chance of judging one URL and
  // fetching another.
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
    execute: decision => fetchRepoFilesImpl(decision.target, fetchOptions, decision),
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
      // The raw input, not a canonicalized one: canonicalization throws on the
      // empty and the malformed, which is exactly what a refusal here reports.
      repoUrl: guarded.target || rawRepoUrl,
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
