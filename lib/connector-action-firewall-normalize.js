'use strict';

// #2190: normalizing an untrusted connector request -- name, approval,
// policy, HTTP target -- and the malformed-request decision.

const { AGENT_ACTION_FIREWALL_VERSION, AGENT_ACTION_FIREWALL_DECISIONS } = require('./agent-action-firewall');
const { canonicalizeGitHubRepoUrl } = require('./github-url');
const { validateConnectorLocalPath } = require('./connector-local-path');
const { CONNECTOR_ACTIONS, CONNECTOR_ACTION_FIREWALL_VERSION } = require('./connector-action-firewall-contracts');

function text(value, fallback = '', max = 160) {
  const normalized = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, ''); // oxlint-disable-line no-control-regex -- deliberate: strips control characters before the action is classified
  return (normalized || fallback).slice(0, max);
}

function normalizeConnectorName(value) {
  const normalized = text(value).toLowerCase();
  return normalized === 'repo' ? 'github' : normalized;
}

function normalizeApproval(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const allowed = {};
  for (const key of ['explicit', 'approved', 'mergeApproved', 'deployApproved', 'releaseApproved']) {
    if (value[key] === true) allowed[key] = true;
  }
  return Object.keys(allowed).length > 0 ? allowed : undefined;
}

function malformedConnectorDecision({ connector, action, reason, target = '' } = {}) {
  return {
    ok: false,
    canExecute: false,
    connector: connector || 'unknown',
    action: action || 'unknown',
    target: text(target, '', 256),
    decision: AGENT_ACTION_FIREWALL_DECISIONS.BLOCK,
    reason,
    connectorFirewallVersion: CONNECTOR_ACTION_FIREWALL_VERSION,
    firewallVersion: AGENT_ACTION_FIREWALL_VERSION,
    firewall: null,
  };
}

function normalizeConnectorPolicy(contract, targetCount) {
  const budget = contract?.budget;
  const budgetClass = text(budget?.class, '', 64);
  const egressClass = text(contract?.egressClass, '', 64);
  if (!budget || !budgetClass || !egressClass
    || !Number.isInteger(budget.maxTargets) || budget.maxTargets < 1
    || !Number.isFinite(budget.costPerTarget) || budget.costPerTarget <= 0
    || !Number.isFinite(budget.maxCostUnits) || budget.maxCostUnits <= 0
    || !Number.isInteger(targetCount) || targetCount < 1) {
    return { ok: false, reason: 'CONNECTOR_POLICY_MISSING' };
  }

  const costUnits = targetCount * budget.costPerTarget;
  if (targetCount > budget.maxTargets) {
    return { ok: false, reason: 'CONNECTOR_BUDGET_TARGET_LIMIT' };
  }
  if (costUnits > budget.maxCostUnits) {
    return { ok: false, reason: 'CONNECTOR_BUDGET_COST_LIMIT' };
  }

  return {
    ok: true,
    egressClass,
    budget: Object.freeze({
      class: budgetClass,
      targetCount,
      costPerTarget: budget.costPerTarget,
      costUnits,
      maxTargets: budget.maxTargets,
      maxCostUnits: budget.maxCostUnits,
    }),
  };
}

function normalizeHttpTarget(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function normalizeConnectorAction(request = {}) {
  const connector = normalizeConnectorName(request.connector || request.sourceType);
  const action = text(request.action || 'ingest').toLowerCase();
  const contract = CONNECTOR_ACTIONS[connector]?.[action];
  if (!contract) {
    return malformedConnectorDecision({
      connector,
      action,
      reason: 'CONNECTOR_ACTION_UNKNOWN',
    });
  }

  let target;
  let targetRef;
  let targets;
  let rootPath;
  if (connector === 'github') {
    let canonical;
    try {
      canonical = canonicalizeGitHubRepoUrl(request.repoUrl || request.url);
    } catch (error) {
      return malformedConnectorDecision({
        connector,
        action,
        reason: error?.code === 'REPO_URL_REQUIRED'
          ? 'CONNECTOR_TARGET_REQUIRED'
          : 'CONNECTOR_TARGET_INVALID',
      });
    }
    target = canonical.repoUrl;
    targetRef = `${canonical.owner}/${canonical.repo}`;
  } else if (connector === 'http') {
    const rawTargets = Array.isArray(request.urls)
      ? request.urls
      : [request.url || request.target];
    if (rawTargets.length === 0 || rawTargets.some(value => !String(value || '').trim())) {
      return malformedConnectorDecision({
        connector,
        action,
        reason: 'CONNECTOR_TARGET_REQUIRED',
      });
    }
    targets = rawTargets.map(normalizeHttpTarget);
    if (targets.some(value => !value)) {
      return malformedConnectorDecision({
        connector,
        action,
        reason: 'CONNECTOR_TARGET_INVALID',
      });
    }
    target = targets.join('|').slice(0, 2048);
    targetRef = targets[0];
  } else {
    const local = validateConnectorLocalPath(
      request.targetPath ?? request.path ?? request.target, request.rootPath,
    );
    if (!local.ok) return malformedConnectorDecision({ connector, action, reason: local.reason });
    target = local.target;
    rootPath = local.rootPath;
    targetRef = target;
  }

  const policy = normalizeConnectorPolicy(contract, targets ? targets.length : 1);
  if (!policy.ok) {
    return malformedConnectorDecision({ connector, action, reason: policy.reason, target });
  }

  return {
    ok: true,
    connector,
    action,
    canonicalAction: contract.canonicalAction,
    firewallAction: contract.firewallAction,
    executor: contract.executor,
    stateMutationBoundary: contract.stateMutationBoundary,
    target,
    targetRef,
    ...(targets ? { targets } : {}),
    ...(rootPath ? { rootPath } : {}),
    egressClass: policy.egressClass,
    budget: policy.budget,
    branch: text(request.branch, 'main', 128),
    workspaceId: text(request.workspaceId, 'default', 128),
    actor: text(request.actor, `connector:${connector}`, 128),
    preview: request.preview === true,
    dryRun: request.dryRun === true,
    approval: normalizeApproval(request.approval),
  };
}

module.exports = {
  malformedConnectorDecision,
  normalizeConnectorAction,
  text,
};
