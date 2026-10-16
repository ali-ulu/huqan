'use strict';

// Who may call the MCP operator tools, and the verdict those calls carry
// instead of a gate evaluation (#2142).

const { constantTimeEqual } = require('../../requestGuards');
const { capabilityBinding, verifyMcpOperatorCapability } = require('../mcp-operator-capability');

function operatorCapabilityBinding(name, args) {
  return capabilityBinding({
    tool: name,
    workspaceId: String(args.workspaceId || 'default'),
    approvalId: name === 'huqan.approve' ? String(args.approvalId || '') : null,
    runId: name === 'huqan.agent_resume' ? String(args.runId || args.checkpointId || '') : null,
    arguments: args,
  });
}

function isMcpOperatorAuthorized(configuredToken, presentedToken) {
  if (typeof configuredToken !== 'string' || typeof presentedToken !== 'string' || !configuredToken || !presentedToken) return false;
  return constantTimeEqual(configuredToken, presentedToken);
}

function operatorCapabilityAuthorized(runtime, name, args, presentedCapability, presentedToken) {
  const secret = runtime?.operatorSecret;
  if (typeof secret === 'string' && secret && typeof presentedCapability === 'string') {
    const binding = operatorCapabilityBinding(name, args);
    const result = verifyMcpOperatorCapability({
      secret,
      capability: presentedCapability,
      expected: binding,
      nonceStore: runtime.operatorCapabilityNonces,
    });
    return result.ok === true;
  }
  // Deprecated in-process compatibility only. createServer() never supplies
  // operatorToken to this seam, so a network MCP caller cannot use the static
  // credential path. CLI and HTTP production callers use scoped capabilities.
  if (typeof runtime?.operatorToken === 'string' && typeof presentedToken === 'string') {
    return isMcpOperatorAuthorized(runtime.operatorToken, presentedToken);
  }
  return false;
}

/**
 * The verdict stamped on the operator-token tools, which bypass evaluateMcpGate.
 *
 * The elevated path itself is a design choice: the operator token is a stronger
 * credential than an ordinary MCP caller holds. What was wrong is what the
 * receipt said about it. The reason read `operator_authorized` beside a
 * `decision: 'allow'`, which is indistinguishable from a verdict the gates
 * produced -- so an auditor reading a stored receipt could not tell "the gates
 * evaluated this and allowed it" from "the gates were never consulted" (#1183).
 *
 * That distinction is the whole point of the receipt. It matters most for
 * `huqan.agent_resume`, which runs the real agent (`executeMcpAgentContinuation`
 * -> `agent.run(goal, { resume: true })`), while the same run started through
 * `huqan.agent` is classified `dry_run_only` after AB1/AB2/AB5/AB8/AB9/AB11.
 * The resumed run still passes agent.v3's own internal gates; what it skips is
 * this surface's evaluation, and now it says so.
 */
const OPERATOR_AUTHORIZED_VERDICT = Object.freeze({
  decision: 'allow',
  reason: 'operator_authorized_gates_not_evaluated',
  requiredReview: false,
  gatesEvaluated: false,
});

module.exports = {
  operatorCapabilityBinding,
  operatorCapabilityAuthorized,
  OPERATOR_AUTHORIZED_VERDICT,
};
