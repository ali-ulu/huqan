'use strict';

// Agent action firewall facade (#2197): one decision seam for all agent
// action execution surfaces. Signal extraction lives in
// lib/agent-action-signals.js, verdict builders in
// lib/agent-action-decisions.js, step enforcement in
// lib/agent-action-step-enforcement.js (required directly by its callers,
// never re-exported here, so the direction stays acyclic).
//
// The firewall deliberately does not persist caller input. Its metadata
// contains only a bounded key list and a one-way action fingerprint. AB5
// remains the source of truth for automation classification; this module
// supplies the agent context, fail-closed execution semantics, and
// surface-independent audit data.

const {
  evaluateAutomationSafety,
  normalizeAutomationSafetyDecision,
} = require('./automation-safety-gate');
const { isSecretLikeValue } = require('./automation-safety-gate/automation-input-normalizer');
const {
  AGENT_ACTION_FIREWALL_DECISIONS,
  AGENT_ACTION_FIREWALL_VERSION,
  INTERNAL_ACTION_CAPABILITY,
  MAX_OPERATION_FIELD_CHARS,
  SAFE_READ_TOOLS,
  actionText,
  buildMetadata,
  firstText,
  hasAutomationMarker,
  hasStructuredAction,
  inputFieldEvidence,
  isSafeReadTool,
  normalizeToolName,
} = require('./agent-action-signals');
const {
  attachFirewallMetadata,
  firewallError,
  malformedDecision,
  safeAllowDecision,
} = require('./agent-action-decisions');

/**
 * One decision seam for all agent action execution surfaces.
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
  const trustedInternal = request[INTERNAL_ACTION_CAPABILITY] === true;
  // The canonical and compatibility MCP namespaces carry the same semantics
  // as their local short name. Arbitrary namespaces remain unknown: an
  // attacker cannot name an execution tool `evil.verify` to inherit this path.
  const readOnly = isSafeReadTool(tool);

  // Workflow analysis tools are trusted local code, not external automation
  // connectors. Keep them visible in the same audit contract, but do not make
  // AB5 classify an ordinary internal query as an unknown external mutation.
  // Secret-like payloads still fall through to AB5 and remain fail-closed.
  if (trustedInternal && !secretDetected) {
    return safeAllowDecision(metadata, 'AGENT_INTERNAL_TOOL_ALLOWED');
  }
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
      operationObject[key] = typeof input[key] === 'string' ? input[key].slice(0, MAX_OPERATION_FIELD_CHARS) : input[key];
    }
  }
  if (action && !operationObject.action) operationObject.action = action;

  // #3618: name the clip that just happened, as length before/after. Appended
  // only when a field was actually cut, so every other metadata keeps its exact
  // shape and the audit-only metadata stays a value-free summary.
  const fieldEvidence = inputFieldEvidence(input);

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
    // #2024: the firewall inspects the caller's whole payload, AB5 only sees
    // the projection above. Carry the detection across as a boolean so a
    // nested secret is not lost, without copying the value into the decision.
    __secretSignal: secretDetected,
  };

  let decision;
  try {
    decision = evaluateAutomationSafety(ab5Input);
  } catch (error) {
    const malformed = malformedDecision(metadata, 'AGENT_ACTION_FIREWALL_EVALUATION_FAILED');
    return fieldEvidence.length
      ? attachFirewallMetadata(malformed, {}, { fieldEvidence })
      : malformed;
  }

  return attachFirewallMetadata(normalizeAutomationSafetyDecision({
    ...decision,
    metadata: {
      ...decision.metadata,
      ...metadata,
      ab5: true,
    },
  }), metadata, fieldEvidence.length ? { ab5: true, fieldEvidence } : { ab5: true });
}

module.exports = {
  AGENT_ACTION_FIREWALL_VERSION,
  AGENT_ACTION_FIREWALL_DECISIONS,
  SAFE_READ_TOOLS,
  evaluateAgentActionFirewall,
  firewallError,
};
