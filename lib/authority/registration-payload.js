'use strict';

// What the runtime registers with the approval authority for one pending
// approval (#3860, ADR-016).
//
// The action hash is computed exactly as the decision guard recomputes it at
// decision time -- canonical tool name, workspace, approval id, the row's
// stored arguments -- so the decision the operator signs is the one the guard
// will accept, and the authority recomputes it again from the arguments it is
// shown. The consume proof is derived from a key in the user's profile: it
// keeps other local processes from burning an approved decision casually, but
// code running as the same user can read that key, so it protects
// availability, never authority (ADR-016 residual risk 5).

const crypto = require('node:crypto');
const { canonicalActionHash } = require('../mcp-operator-capability');
const { canonicalMcpToolName } = require('../mcp-tool-names');
const { parseJsonObject } = require('../json-object');
const { mcpApprovalExpiresAt } = require('../mcp-approval-expiry');

const SUMMARY_ARGUMENTS_CHARS = 240;

function consumeProofFor(consumeKey, approvalId) {
  return crypto.createHmac('sha256', consumeKey).update(`huqan.authority.consume.v1\n${approvalId}`, 'utf8').digest('hex');
}

function storedArgumentsOf(approval) {
  return approval.context?.args && typeof approval.context.args === 'object'
    ? approval.context.args
    : parseJsonObject(approval.input, {});
}

/** @returns {object|null} the registration body, or null when the row has no derivable expiry */
function buildRegistration(approval, { consumeKey, ttlMs }) {
  const tool = canonicalMcpToolName(approval.tool);
  const workspaceId = approval.workspaceId || 'default';
  const args = storedArgumentsOf(approval);
  const rawExpiry = approval.context?.expiresAt || mcpApprovalExpiresAt(approval.createdAt, ttlMs);
  if (!rawExpiry) return null;
  // A malformed stored expiry is reported for this row, not thrown across the whole sync.
  const expiry = Date.parse(String(rawExpiry));
  if (!Number.isFinite(expiry)) return null;
  const proof = consumeProofFor(consumeKey, approval.id);
  return {
    approvalId: approval.id,
    workspaceId,
    tool,
    arguments: args,
    actionHash: canonicalActionHash({ tool, workspaceId, approvalId: approval.id, arguments: args }),
    consumeProofHash: crypto.createHash('sha256').update(proof, 'utf8').digest('hex'),
    summary: `${tool} ${JSON.stringify(args).slice(0, SUMMARY_ARGUMENTS_CHARS)}`,
    expiresAt: new Date(expiry).toISOString(),
  };
}

module.exports = { consumeProofFor, storedArgumentsOf, buildRegistration };
