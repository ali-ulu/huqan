'use strict';

const crypto = require('crypto');
const {
  evaluateAutomationSafety,
  normalizeAutomationSafetyDecision,
} = require('./automation-safety-gate');
const {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_SAFETY_POLICY_VERSION,
} = require('./automation-safety-gate/automation-safety-vocabulary');
const { isSecretLikeValue } = require('./automation-safety-gate/automation-input-normalizer');

const AGENT_ACTION_FIREWALL_VERSION = 'AAFW-v1.0.0';

const SAFE_READ_TOOLS = new Set([
  'ask',
  'verify',
  'reason',
  'compare',
  'dream',
  'plan',
]);

const AGENT_ACTION_FIREWALL_DECISIONS = Object.freeze({
  ALLOW: AUTOMATION_SAFETY_DECISIONS.ALLOW,
  REVIEW: AUTOMATION_SAFETY_DECISIONS.REVIEW,
  BLOCK: AUTOMATION_SAFETY_DECISIONS.BLOCK,
  DRY_RUN_ONLY: AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
});

const STRUCTURED_ACTION_KEYS = Object.freeze([
  'action',
  'operation',
  'operationType',
  'intent',
  'command',
  'cmd',
  'shell',
  'script',
  'exec',
  'target',
  'deploy',
  'release',
  'merge',
  'workflow',
  'branch',
  'baseBranch',
]);

const AUTOMATION_MARKERS = Object.freeze([
  'deploy',
  'release',
  'merge',
  'push',
  'force push',
  'force_push',
  'rebase',
  'reset hard',
  'delete branch',
  'branch protection',
  'workflow dispatch',
  'skip ci',
  'bypass ci',
  'auto merge',
  'automerge',
  'secret persistence',
  'token persistence',
  'repo settings',
  'destructive cleanup',
  'purge',
  'wipe',
]);

function cloneValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function normalizeToolName(value) {
  return String(value || '').trim().toLowerCase();
}

function inputKeys(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.keys(input).sort().slice(0, 32);
}

function actionText({ tool, action, input }) {
  const values = [tool, action];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of STRUCTURED_ACTION_KEYS) {
      const value = input[key];
      if (typeof value === 'string') values.push(value.slice(0, 256));
      else if (value && typeof value === 'object' && key !== 'target') values.push(JSON.stringify(value).slice(0, 256));
    }
  }
  return values.filter(Boolean).join(' ').toLowerCase();
}

function hasAutomationMarker(value) {
  const text = String(value || '').toLowerCase();
  return AUTOMATION_MARKERS.some(marker => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[_-]+/g, '[ _-]+');
    return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s|[/:])`, 'i').test(text);
  });
}

function hasStructuredAction(input) {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input)
    && STRUCTURED_ACTION_KEYS.some(key => Object.prototype.hasOwnProperty.call(input, key)));
}

function fingerprint({ surface, tool, action, workspaceId, target }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ surface, tool, action, workspaceId, target }))
    .digest('hex')
    .slice(0, 24);
}

function buildMetadata({ surface, tool, action, input, context, target }) {
  const workspaceId = firstText(context?.workspaceId, context?.metadata?.workspaceId, 'default') || 'default';
  return {
    workspaceId,
    surface: firstText(surface, 'agent'),
    tool: normalizeToolName(tool),
    action: firstText(action, input?.action, input?.operationType, input?.operation, ''),
    actionId: fingerprint({
      surface: firstText(surface, 'agent'),
      tool: normalizeToolName(tool),
      action: firstText(action, input?.action, input?.operationType, input?.operation, ''),
      workspaceId,
      target,
    }),
    inputKeys: inputKeys(input),
    firewallVersion: AGENT_ACTION_FIREWALL_VERSION,
  };
}

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

/**
 * One decision seam for all agent action execution surfaces.
 *
 * The firewall deliberately does not persist caller input. Its metadata contains
 * only a bounded key list and a one-way action fingerprint. AB5 remains the
 * source of truth for automation classification; this module supplies the agent
 * context, fail-closed execution semantics, and surface-independent audit data.
 */
function evaluateAgentActionFirewall(request = {}) {
  const input = request && typeof request === 'object' ? request.input : undefined;
  const tool = normalizeToolName(request.tool);
  const action = firstText(request.action, input && input.action, input && input.operationType, input && input.operation, '');
  const context = request.context && typeof request.context === 'object' ? request.context : {};
  const target = firstText(
    input && typeof input === 'object' && input.target,
    input && typeof input === 'object' && input.resource,
    context.target,
    tool,
  );
  const metadata = buildMetadata({
    surface: request.surface,
    tool,
    action,
    input,
    context,
    target,
  });

  if (!tool) return malformedDecision(metadata);

  const secretDetected = isSecretLikeValue(input);
  const readOnly = SAFE_READ_TOOLS.has(tool);
  const structured = hasStructuredAction(input);
  const explicitAutomation = structured && hasAutomationMarker(actionText({ tool, action, input }));

  // Analysis tools are not execution tools. A user can ask the agent to explain
  // a force-push without the firewall mistaking that question for a force-push.
  if (readOnly && !secretDetected) {
    return safeAllowDecision(metadata);
  }

  // Normal HUQAN memory learning is handled by AB4/kernel admission. It is not
  // an automation action unless the caller supplied an explicit action object.
  if (tool === 'learn' && !structured && !secretDetected) {
    return safeAllowDecision(metadata, 'AGENT_MEMORY_WRITE_DELEGATED_TO_AB4');
  }

  if (tool === 'learn' && !explicitAutomation && !secretDetected) {
    return safeAllowDecision(metadata, 'AGENT_MEMORY_WRITE_DELEGATED_TO_AB4');
  }

  const operationObject = {};
  for (const key of ['operationType', 'action', 'intent', 'target', 'branch', 'baseBranch', 'command', 'cmd', 'shell', 'script', 'exec']) {
    if (input && typeof input === 'object' && input[key] !== undefined) {
      operationObject[key] = typeof input[key] === 'string' ? input[key].slice(0, 512) : input[key];
    }
  }
  if (action && !operationObject.action) operationObject.action = action;

  const ab5Input = {
    operation: operationObject,
    operationType: firstText(
      input && input.operationType,
      input && input.action,
      input && input.intent,
      action,
      tool,
    ) || 'unknown',
    target,
    actor: firstText(context.actor, `agent:${metadata.surface}`),
    branch: firstText(context.branch, input && input.branch, ''),
    baseBranch: firstText(context.baseBranch, input && input.baseBranch, ''),
    repoState: context.repoState,
    approval: request.approval || context.approval,
    preview: Boolean(request.preview || context.preview || input?.preview),
    dryRun: Boolean(request.dryRun || context.dryRun || input?.dryRun),
    metadata,
    policyOverride: request.policyOverride || context.policyOverride,
  };

  let decision;
  try {
    decision = evaluateAutomationSafety(ab5Input);
  } catch (error) {
    return malformedDecision(metadata, 'AGENT_ACTION_FIREWALL_EVALUATION_FAILED');
  }

  return attachFirewallMetadata(normalizeAutomationSafetyDecision({
    ...decision,
    metadata: {
      ...decision.metadata,
      ...metadata,
      ab5: true,
    },
  }), metadata, { ab5: true });
}

function firewallError(decision) {
  if (decision === AGENT_ACTION_FIREWALL_DECISIONS.BLOCK) return 'AGENT_ACTION_BLOCKED';
  if (decision === AGENT_ACTION_FIREWALL_DECISIONS.DRY_RUN_ONLY) return 'AGENT_ACTION_DRY_RUN_ONLY';
  return 'AGENT_ACTION_REVIEW_REQUIRED';
}

module.exports = {
  AGENT_ACTION_FIREWALL_VERSION,
  AGENT_ACTION_FIREWALL_DECISIONS,
  SAFE_READ_TOOLS,
  evaluateAgentActionFirewall,
  firewallError,
};
