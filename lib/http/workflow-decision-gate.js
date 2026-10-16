'use strict';

// The operator-authority half of the workflow learn-approval decision (#3926).
//
// `POST /api/v2/approvals/{id}/decision` executed a learn decision on a bare
// API key: whoever could propose a learn (the same key) could also approve it,
// collapsing the separation the review gate exists to create. The memory
// approval surface refuses exactly that shape -- its file-head comment calls
// it self-approval -- and requires a short-lived, scope-bound operator
// capability in `x-huqan-operator-capability` on top of the transport key.
//
// This module is the one place the workflow decision reads that authority, so
// the two surfaces cannot drift from each other. The binding is the same
// `huqan.approve` binding the memory surface verifies (same approval,
// workspace, decision and reason), and the consumed-nonce store defaults to
// the same directory the memory boundary uses, so a capability spent on one
// surface cannot replay on the other. The ledger the MCP tools consult is not
// consulted here: this is not a stop check, it is the decision authority
// itself.

const os = require('node:os');
const path = require('node:path');
const { verifyMcpOperatorCapability } = require('../mcp-operator-capability');
const { operatorCapabilityBinding } = require('../mcp/operator-authorization');

const OPERATOR_DECISION_HEADER = 'x-huqan-operator-capability';
// The refusal a learn decision answers without operator authority -- the same
// refusal the memory-approval surface sends.
const OPERATOR_AUTH_REQUIRED_CODE = 'OPERATOR_AUTH_REQUIRED';

/**
 * Where consumed decision nonces live when the caller supplies no store.
 *
 * Beside the memory store, so a deployment that already persists memory to a
 * mounted volume gets durable replay protection with no extra configuration --
 * and, deliberately, the same directory the memory-approval boundary
 * defaults to, so the two surfaces share one spent-nonce record.
 */
function workflowDecisionNonceDirectory(kernel) {
  const memoryPath = kernel && kernel.graph && typeof kernel.graph.memoryPath === 'string'
    ? kernel.graph.memoryPath.trim()
    : '';
  const base = memoryPath
    ? path.dirname(path.resolve(memoryPath))
    : path.join(os.homedir(), '.local', 'state', 'huqan');
  return path.join(base, '.huqan-capability-nonces');
}

function readWorkflowDecisionCapability(req) {
  const raw = req && req.headers ? req.headers[OPERATOR_DECISION_HEADER] : '';
  return typeof raw === 'string' ? raw : '';
}

/**
 * Whether the presented capability authorizes this exact decision.
 *
 * @param {{ operatorToken?: string, capability?: string, approvalId?: string,
 *   workspaceId?: string, decision?: string, reason?: string,
 *   nonceStore?: object }} options
 * @returns {boolean}
 */
function verifyWorkflowDecisionCapability({ operatorToken, capability, approvalId, workspaceId, decision, reason = '', nonceStore } = {}) {
  if (typeof operatorToken !== 'string' || !operatorToken || typeof capability !== 'string' || !capability) return false;
  const args = {
    approvalId: String(approvalId || ''),
    workspaceId: String(workspaceId || 'default'),
    decision: String(decision || ''),
    reason: String(reason || ''),
  };
  if (!args.approvalId || !args.decision) return false;
  const result = verifyMcpOperatorCapability({
    secret: operatorToken,
    capability,
    expected: operatorCapabilityBinding('huqan.approve', args),
    nonceStore,
  });
  return result.ok === true;
}

module.exports = Object.freeze({
  OPERATOR_DECISION_HEADER,
  OPERATOR_AUTH_REQUIRED_CODE,
  workflowDecisionNonceDirectory,
  readWorkflowDecisionCapability,
  verifyWorkflowDecisionCapability,
});
