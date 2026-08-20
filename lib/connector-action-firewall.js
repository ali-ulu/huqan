'use strict';

const {
  AGENT_ACTION_FIREWALL_VERSION,
  AGENT_ACTION_FIREWALL_DECISIONS,
  evaluateAgentActionFirewall,
} = require('./agent-action-firewall');
const { canonicalizeGitHubRepoUrl } = require('./github-url');

const CONNECTOR_ACTION_FIREWALL_VERSION = 'CAF-v1.0.0';

const CONNECTOR_ACTIONS = Object.freeze({
  github: Object.freeze({
    ingest: Object.freeze({
      canonicalAction: 'github.read_repository',
      firewallAction: 'read_repository',
      targetField: 'repoUrl',
      executor: 'fetchRepoFiles',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
    }),
  }),
  markdown: Object.freeze({
    ingest: Object.freeze({
      canonicalAction: 'markdown.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestMarkdown',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
    }),
  }),
  json: Object.freeze({
    ingest: Object.freeze({
      canonicalAction: 'json.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestJson',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
    }),
  }),
  yaml: Object.freeze({
    ingest: Object.freeze({
      canonicalAction: 'yaml.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestYaml',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
    }),
  }),
  'git-log': Object.freeze({
    ingest: Object.freeze({
      canonicalAction: 'git_log.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestGitLog',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
    }),
  }),
  pdf: Object.freeze({
    ingest: Object.freeze({
      canonicalAction: 'pdf.read_source',
      firewallAction: 'read_repository',
      targetField: 'targetPath',
      executor: 'ingestPdf',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
    }),
  }),
  http: Object.freeze({
    ingest: Object.freeze({
      canonicalAction: 'http.fetch_url',
      firewallAction: 'read_repository',
      targetField: 'urls',
      executor: 'ingestUrls',
      stateMutationBoundary: 'kernel.proposeNode/proposeEdge',
    }),
  }),
});

function text(value, fallback = '', max = 160) {
  const normalized = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
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
    target = text(request.targetPath || request.path || request.target, '', 1024);
    if (!target) {
      return malformedConnectorDecision({
        connector,
        action,
        reason: 'CONNECTOR_TARGET_REQUIRED',
      });
    }
    targetRef = target;
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
    branch: text(request.branch, 'main', 128),
    workspaceId: text(request.workspaceId, 'default', 128),
    actor: text(request.actor, `connector:${connector}`, 128),
    preview: request.preview === true,
    dryRun: request.dryRun === true,
    approval: normalizeApproval(request.approval),
  };
}

function summarizeFirewall(firewall) {
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
    firewallSummary: summarizeFirewall(firewall),
  };
}

async function executeConnectorAction({ request = {}, execute } = {}) {
  const decision = evaluateConnectorAction(request);
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
  normalizeConnectorAction,
  evaluateConnectorAction,
  executeConnectorAction,
};
