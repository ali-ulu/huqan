'use strict';

/**
 * Read one approval by its id, over MCP.
 *
 * `huqan.learn` returns an approvalId, and until this tool existed an MCP
 * client could list approvals and decide them but could not open one.
 * `huqan.approvals` returns a bounded window of unresolved rows, so an approval
 * outside that window -- or already resolved -- could not be read from MCP at
 * all; reading one by id lived only on `GET /api/v2/approvals/{id}`.
 *
 * Two boundaries are deliberate:
 *
 * - Operator-gated in mcpServer.js, exactly like `huqan.approvals`. The same
 *   data seen one row at a time must not become a way around the capability
 *   that guards the list.
 * - Scoped to one workspace. The store is asked for the id *within* the
 *   workspace, so knowing an id from another workspace is a miss rather than a
 *   read.
 *
 * The row is projected through projectApprovalRecord, the same projection the
 * list tool uses, which redacts secret-looking values. Approval rows carry the
 * arguments the caller passed to a gated tool, which is exactly where a secret
 * would be sitting; reading one row must not be the unredacted path.
 *
 * Unlike the HTTP route, no tool filter is applied: that route is the workflow
 * approvals API and shows only ingest and learn rows, while the MCP list shows
 * every approval in the workspace. This is the MCP list's counterpart, so it
 * matches the MCP list.
 */

const { projectApprovalRecord } = require('../mcp-approval-views');
const { sanitizeMcpString } = require('../mcp-input-sanitizers');
const { withMcpToolVerdictSurface } = require('./response-builders');

function failure(code, message) {
  return {
    ok: false,
    type: 'approval_detail',
    data: null,
    evidence: [],
    error: { code, message },
    meta: {},
  };
}

function executeMcpApprovalDetail({ store, name, args, gate }) {
  const workspaceId = sanitizeMcpString(args.workspaceId, 128);
  const approvalId = sanitizeMcpString(args.approvalId, 256);

  if (!workspaceId || !approvalId) {
    return withMcpToolVerdictSurface(
      failure('INVALID_INPUT', 'workspaceId and approvalId are both required.'),
      name, args, gate,
    );
  }

  // "The store could not be opened" and "there is no such approval" are
  // different answers, and collapsing the first into the second would report a
  // broken store as an empty one.
  if (!store || typeof store.getToolApprovalById !== 'function') {
    return withMcpToolVerdictSurface(
      failure('APPROVAL_STORE_UNAVAILABLE', 'Persistent approval store is unavailable.'),
      name, args, gate,
    );
  }

  let record = null;
  try {
    record = store.getToolApprovalById(approvalId, workspaceId);
  } catch (error) {
    return withMcpToolVerdictSurface(
      failure('APPROVAL_STORE_UNAVAILABLE', `Approval store read failed: ${error.message}`),
      name, args, gate,
    );
  }

  const approval = projectApprovalRecord(record);
  if (!approval || approval.workspaceId !== workspaceId) {
    return withMcpToolVerdictSurface(
      failure('APPROVAL_NOT_FOUND', 'Approval was not found in this workspace.'),
      name, args, gate,
    );
  }

  return withMcpToolVerdictSurface({
    ok: true,
    type: 'approval_detail',
    data: { approval, workspaceId },
    evidence: [],
    error: null,
    meta: {},
  }, name, args, gate);
}

module.exports = { executeMcpApprovalDetail };
