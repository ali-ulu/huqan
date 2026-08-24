'use strict';

const { formatApprovalRecord } = require('./mcp-approval-views');
const { createApprovalStoreFromKernel } = require('./mcp-approval-store');
const { buildIngestWorkflowRun } = require('./ingest-workflow-run');
const { sanitizeMcpString, MCP_MAX_SHORT } = require('./mcp-input-sanitizers');

const OPERATION = 'ingest_status';

function approvalWorkspace(approval) {
  return String(
    approval?.workspaceId
      || approval?.context?.snapshot?.workspaceId
      || approval?.context?.workspaceId
      || '',
  );
}

// Read-only by construction: this reads the approval the HTTP surface owns and
// projects it exactly as GET /api/v2/ingest/runs/{id} does. It never claims,
// decides or executes, so the approval authority that #797 moved out of
// model-visible tools stays where it is.
function readIngestRunStatus(kernel, args = {}, runtime = {}) {
  const runId = sanitizeMcpString(args.runId, MCP_MAX_SHORT);
  const workspaceId = sanitizeMcpString(args.workspaceId, MCP_MAX_SHORT);
  if (!runId || !workspaceId) {
    return kernel._fail(OPERATION, 'INVALID_INPUT', 'runId and workspaceId are required.');
  }

  const store = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
  if (!store || typeof store.getToolApprovalById !== 'function') {
    return kernel._fail(OPERATION, 'APPROVAL_STORE_UNAVAILABLE', 'Persistent approval store is unavailable.');
  }

  const approval = formatApprovalRecord(store.getToolApprovalById(runId, workspaceId));
  // A run from another workspace is reported as missing rather than as a
  // permission error, so this cannot be used to probe for run ids.
  if (!approval || approval.tool !== 'http.ingest' || approvalWorkspace(approval) !== workspaceId) {
    return kernel._fail(OPERATION, 'INGEST_RUN_NOT_FOUND', 'Ingest run was not found in this workspace.');
  }

  const run = buildIngestWorkflowRun(approval);
  if (!run) {
    return kernel._fail(OPERATION, 'INGEST_RUN_STATE_UNKNOWN', 'Ingest run state cannot be projected safely.');
  }
  return kernel._ok(OPERATION, { ...run, workspaceId });
}

module.exports = { readIngestRunStatus };
