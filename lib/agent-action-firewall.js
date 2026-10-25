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
  CLIPPED_OPERATION_KEYS,
  INTERNAL_ACTION_CAPABILITY,
  MAX_OPERATION_FIELD_CHARS,
  SAFE_READ_TOOLS,
  STRUCTURED_ACTION_KEYS,
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
 * The structured fields that name a shell command rather than a subject (#4248).
 */
const EXECUTION_FIELDS = Object.freeze(['command', 'cmd', 'shell', 'script', 'exec']);

// The structured fields that name a *subject* rather than an operation: a read
// may name a branch or a deployment as what it is about without requesting a
// write, so these are excluded from the read-only exemption's operation check
// (CodeRabbit, #4248).
const SUBJECT_FIELD_KEYS = Object.freeze(new Set(['target', 'branch', 'baseBranch']));

// Every structured field that names an operation, taken from the canonical
// `STRUCTURED_ACTION_KEYS` rather than the clipped `CLIPPED_OPERATION_KEYS`,
// which omits `operation` -- a field that can carry the real mutation beside a
// read-shaped `action` (#4248).
const ACTION_FIELD_KEYS = Object.freeze(STRUCTURED_ACTION_KEYS.filter(key => !SUBJECT_FIELD_KEYS.has(key)));

/**
 * The suffixes that describe a read over the object a read tool names:
 * `verify.claim`, `plan.steps`. A read tool may only carry one of these after
 * its own name; any other suffix (`verify.remove`, `plan.destroy`) names an
 * operation the tool does not perform (#4248).
 */
const READ_ACTION_SUFFIXES = Object.freeze(new Set([
  'claim', 'claims', 'fact', 'facts', 'node', 'nodes', 'edge', 'edges',
  'graph', 'status', 'state', 'result', 'results', 'list', 'detail',
  'details', 'summary', 'history', 'log', 'logs', 'steps', 'step',
  'memory', 'knowledge', 'answer', 'question', 'explanation', 'reasoning',
  'comparison', 'diff', 'score', 'metric', 'metrics', 'report',
]));

/**
 * Whether a structured `input` names a shell command rather than a subject. A
 * read-only tool that carries one is describing an execution, not an analysis
 * (#4248). A non-object `input` (free-form text) names no field, so it answers
 * false.
 */
function namesShellCommand(input) {
  if (!input || typeof input !== 'object') return false;
  return EXECUTION_FIELDS.some(key => typeof input[key] === 'string' && input[key].trim().length > 0);
}

function tokensOf(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Whether an action/capability is outside the read vocabulary of a read tool.
 * Empty, the tool's own name, and `verify.claim` are read-shaped; `deploy`,
 * `verify.remove` and `repo.force-push` are not (#4248).
 *
 * A field whose leading token is not a read tool is execution-shaped by
 * construction: `verify` may read a `claim`, but nothing lets it `deploy`,
 * `remove` or `push`. That is why no mutation vocabulary is imported here --
 * AB5 owns the verb list and runs the moment this check declines to exempt.
 */
function mutationShaped(action, tool) {
  const text = String(action).trim().toLowerCase();
  if (!text || text === tool) return false;
  const [head, ...rest] = tokensOf(text);
  if (!SAFE_READ_TOOLS.has(head)) return true;
  return !rest.every(suffix => READ_ACTION_SUFFIXES.has(suffix));
}

/**
 * The operation-bearing field values of a structured `input`: the fields that
 * name an operation, `target` excluded. A free-form `input` (a string) names no
 * field, so it contributes nothing. The top-level `action` is deliberately not
 * included: on the step-enforcement surface it is a step *label*
 * (`dream-experiment-verify`), not a capability, and reading it as one refused
 * an honest dream-verify step (#4248).
 */
function operationFieldValues(input) {
  const values = [];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of ACTION_FIELD_KEYS) values.push(input[key]);
  }
  return values.filter(value => typeof value === 'string' && value.trim());
}

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
  // AB5's automation markers over the selected action. The `learn` delegation
  // below keeps using this exactly as before (#4248 did not touch it).
  const explicitAutomation = structured && hasAutomationMarker(actionText({ tool, action, input }));
  // The read-only exemption must not be steerable by the caller-declared tool
  // name. It is granted only when every operation-bearing field is read-shaped:
  // the field is the tool's own name or a read over it, and no field names a
  // shell command. A field that conflicts with the selected action
  // (`action: 'verify'` beside `operationType: 'repo.remove'`) is enough to
  // fall through to AB5.
  const operationValues = operationFieldValues(input);
  // The top-level `action` is a capability on the direct and A2A surfaces, but
  // a step *label* on the step-enforcement surface (`dream-experiment-verify`),
  // which is why it is only judged when `input` is not free-form text: a string
  // input is a question or a hypothesis, not an operation field (#4248).
  const executionShaped = namesShellCommand(input)
    || operationValues.some(value => mutationShaped(value, tool))
    || (typeof input !== 'string' && mutationShaped(action, tool));

  // Analysis tools are not execution tools. A user can ask the agent to explain
  // a force-push without the firewall mistaking that question for a force-push.
  //
  // #4248: the read-only exemption keyed on the caller-declared tool name, so a
  // caller that declared `verify` while its payload named a mutating capability
  // or carried a shell command was describing an execution, not an analysis.
  // Fall through to AB5 rather than trusting the declaration: the declared name
  // is not evidence of what will run.
  if (readOnly && !secretDetected && !executionShaped) {
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
  for (const key of CLIPPED_OPERATION_KEYS) {
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
