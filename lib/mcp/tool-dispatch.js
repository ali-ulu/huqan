'use strict';

// Routes one MCP tool call: resolves the legacy alias, authorises the operator
// tools, evaluates the gate, and hands the call to its handler or to the
// refusal response (#2142).

const { evaluateMcpGate } = require('../mcp-gate-adapter');
const { emitGateTelemetry } = require('../gate-telemetry');
const { applyHumanApprovalToggle } = require('../human-approval-toggle');
const { parseJsonObject } = require('../json-object');
const {
  canonicalMcpToolName,
  isLegacyMcpToolName,
  withMcpToolDeprecationSurface,
} = require('../mcp-tool-names');
const { executeMcpAgentContinuation } = require('../mcp-agent-continuation');
const { createMcpApprovalDecisionHandler } = require('../mcp-approval-decision-handler');
const { withMcpToolVerdictSurface } = require('./response-builders');
const { OPERATOR_TOOL_NAMES } = require('./tool-surface');
const { operatorCapabilityAuthorized, OPERATOR_AUTHORIZED_VERDICT } = require('./operator-authorization');
const { createMcpToolHandlers, createReadOnlyDryRun } = require('./tool-handlers');
const { respondToGateRefusal } = require('./gate-refusal');
const { bindCall, bindingHolds, isSep986ToolName } = require('../mcp-call-binding');
const { emergencyStopLedger, checkArguments, changeArguments } = require('../emergency-stop');

function failApprovalDecision(code, message, meta = {}) {
  return {
    ok: false,
    type: 'approval',
    data: null,
    evidence: [],
    error: { code, message },
    meta,
  };
}

const handleMcpApprovalDecision = createMcpApprovalDecisionHandler({ failApprovalDecision });

const EMERGENCY_STOP_ACTOR = 'operator:mcp';

function failEmergencyStop(code, message) {
  return {
    ok: false,
    type: 'emergency_stop',
    data: null,
    evidence: [],
    error: { code, message },
    meta: {},
  };
}

/**
 * The `huqan.emergency_stop` operator tool (#2505 F-2b). Capability
 * authorization already passed above; the gate is not evaluated and the
 * verdict says so (OPERATOR_AUTHORIZED_VERDICT). stop/lift/check reach the
 * same ledger the HTTP and CLI surfaces write through, with actor
 * `operator:mcp`, so no second writer exists.
 */
function dispatchEmergencyStop(args, runtime) {
  if (args.action !== 'check' && args.action !== 'stop' && args.action !== 'lift') {
    return withMcpToolVerdictSurface(
      failEmergencyStop('INVALID_ACTION', 'action stop|lift|check is required.'),
      'huqan.emergency_stop',
      args,
      OPERATOR_AUTHORIZED_VERDICT,
    );
  }
  const ledger = emergencyStopLedger(runtime);
  if (args.action === 'check') {
    const outcome = ledger.check(checkArguments(args));
    return withMcpToolVerdictSurface(
      { ok: true, type: 'emergency_stop', data: outcome, evidence: [], meta: {} },
      'huqan.emergency_stop',
      args,
      OPERATOR_AUTHORIZED_VERDICT,
    );
  }
  const shaped = changeArguments(args);
  try {
    const outcome = ledger[shaped.action]({
      scope: shaped.scope,
      workspaceId: shaped.workspaceId,
      agentId: shaped.agentId || undefined,
      reason: shaped.reason,
      actor: EMERGENCY_STOP_ACTOR,
    });
    return withMcpToolVerdictSurface(
      { ok: true, type: 'emergency_stop', data: outcome, evidence: [], meta: {} },
      'huqan.emergency_stop',
      args,
      OPERATOR_AUTHORIZED_VERDICT,
    );
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return withMcpToolVerdictSurface(
      failEmergencyStop('INVALID_INPUT', error.message),
      'huqan.emergency_stop',
      args,
      OPERATOR_AUTHORIZED_VERDICT,
    );
  }
}

function dispatchOperatorTool(kernel, name, args, safeParams, runtime, withTransientAgent) {
  if (!operatorCapabilityAuthorized(runtime, name, args, safeParams.operatorCapability, safeParams.operatorToken)) {
    return withMcpToolVerdictSurface(
      failApprovalDecision(
        'OPERATOR_AUTH_REQUIRED',
        name === 'huqan.agent_resume'
          // Not an approval operation, and saying so matters: the operator
          // reading this needs to know which capability was demanded of them.
          ? 'A scoped operator capability is required to resume an agent run.'
          : name === 'huqan.emergency_stop'
            ? 'A scoped operator capability is required to check, issue or lift an emergency stop.'
            : 'A scoped operator capability is required for this MCP approval operation.',
      ),
      name,
      args,
      { decision: 'block', reason: 'operator_auth_required', requiredReview: false },
    );
  }
  if (name === 'huqan.agent_resume') {
    const continuation = withTransientAgent(kernel, agent => executeMcpAgentContinuation(agent, args));
    return withMcpToolVerdictSurface(continuation, name, args, OPERATOR_AUTHORIZED_VERDICT);
  }
  if (name === 'huqan.emergency_stop') {
    return dispatchEmergencyStop(args, runtime);
  }
  if (name === 'huqan.approve') {
    const approvalDecision = handleMcpApprovalDecision(kernel, args, runtime);
    const projectDecision = (result) => withMcpToolVerdictSurface(
      result,
      name,
      args,
      OPERATOR_AUTHORIZED_VERDICT,
    );
    return approvalDecision && typeof approvalDecision.then === 'function'
      ? approvalDecision.then(projectDecision)
      : projectDecision(approvalDecision);
  }
  // huqan.approvals and huqan.approval_detail continue to the gate and their handlers.
  return undefined;
}

const MAX_REJECTED_NAME = 160;

function describeRejectedName(name) {
  const text = typeof name === 'string' ? JSON.stringify(name) : `<${Array.isArray(name) ? 'array' : typeof name}>`;
  return text.length > MAX_REJECTED_NAME ? `${text.slice(0, MAX_REJECTED_NAME)}…` : text;
}

function createMcpToolDispatch({ withTransientAgent }) {
  const handlers = createMcpToolHandlers({ withTransientAgent });
  const executeReadOnlyDryRun = createReadOnlyDryRun({ withTransientAgent });

  function dispatchMcpTool(kernel, name, safeParams, runtime = {}) {
    const args = parseJsonObject(safeParams.arguments, {});

    if (OPERATOR_TOOL_NAMES.includes(name)) {
      const operatorOutcome = dispatchOperatorTool(kernel, name, args, safeParams, runtime, withTransientAgent);
      if (operatorOutcome !== undefined) return operatorOutcome;
    }

    // #2505 F: an MCP call carries no caller identity, so a workspace stop is
    // what blocks it. Operator tools stay reachable so a stop can be reviewed.
    if (!OPERATOR_TOOL_NAMES.includes(name)) {
      const stop = emergencyStopLedger(runtime).check({
        workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
      });
      if (stop.stopped) {
        return withMcpToolVerdictSurface(
          {
            ok: false, type: 'emergency_stop', data: null, evidence: [],
            error: { code: 'EMERGENCY_STOPPED', message: 'This workspace is under an emergency stop.' },
            meta: { emergencyStop: { scope: stop.scope, reason: stop.reason } },
          },
          name,
          args,
          { decision: 'block', reason: stop.reason, requiredReview: false },
        );
      }
    }

    // The decision is bound to this tool and these arguments (#3488). An
    // argument value JSON cannot represent (BigInt, a cycle) has no canonical
    // form, so nothing can be bound to it and the call is blocked.
    let binding;
    try {
      binding = bindCall(name, args);
    } catch (_) {
      return withMcpToolVerdictSurface({
        ok: false, type: 'mcp_call', data: null, evidence: [],
        error: { code: 'ARGS_NOT_CANONICAL', message: 'The call arguments have no canonical JSON form; nothing ran.' },
        meta: {},
      }, name, args, { decision: 'block', reason: 'args_not_canonical', requiredReview: false });
    }
    const gate = { ...applyHumanApprovalToggle(evaluateMcpGate({ tool: name, args, metadata: {} })), binding };
    emitGateTelemetry(kernel, 'mcp-tool-call', { tool: name, decision: gate.decision, reason: gate.reason, findings: gate.findings, metadata: gate.metadata });

    if (!gate.canExecute) {
      return respondToGateRefusal({ kernel, name, args, gate, runtime, executeReadOnlyDryRun });
    }

    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    // Nothing between the decision and here may have changed what it decided.
    if (!bindingHolds(binding, name, args)) {
      return withMcpToolVerdictSurface({
        ok: false, type: 'mcp_call', data: null, evidence: [],
        error: { code: 'CALL_BINDING_BROKEN', message: 'The call arguments changed after the gate decided; nothing ran.' },
        meta: {},
      }, name, args, { ...gate, decision: 'block', reason: 'call_binding_broken' });
    }
    return handler({ kernel, name, args, gate, runtime });
  }

  /**
   * RFC-001 reader half: accept both spellings, resolve to one handler.
   *
   * The requested name is canonicalized once, here, and every downstream
   * consumer — gate evaluation, approval persistence, dispatch, dry-run — sees
   * only the canonical `huqan.*` name. That is what makes "both names resolve to
   * the same handler" structural rather than a pair of parallel switch arms that
   * could drift.
   */
  function callTool(kernel, params = {}, runtime = {}) {
    const safeParams = params && typeof params === 'object' ? params : {};
    // SEP-986: refused, not repaired. Trimming or stripping a name used to
    // turn " huqan.status " into a call to huqan.status. A name outside the
    // rule now reaches the gate as no name at all, which blocks it as
    // malformed input with its verdict surface (#3488).
    const requestedName = isSep986ToolName(safeParams.name) ? safeParams.name : '';
    if (!requestedName) {
      // The refused name is kept for incident review, escaped and bounded.
      emitGateTelemetry(kernel, 'mcp-tool-name', {
        decision: 'block',
        reason: 'invalid_tool_name',
        metadata: { tool: '', rejectedName: describeRejectedName(safeParams.name) },
      });
    }
    const outcome = dispatchMcpTool(kernel, canonicalMcpToolName(requestedName), safeParams, runtime);
    if (!isLegacyMcpToolName(requestedName)) return outcome;
    if (outcome && typeof outcome.then === 'function') {
      return outcome.then((value) => withMcpToolDeprecationSurface(value, requestedName));
    }
    return withMcpToolDeprecationSurface(outcome, requestedName);
  }

  return { callTool, executeReadOnlyDryRun };
}

module.exports = {
  createMcpToolDispatch,
};
