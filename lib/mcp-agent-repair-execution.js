'use strict';

/**
 * Executing an approved repair (#3151, owner decision 2026-09-29: a repair
 * runs automatically once it is approved).
 *
 * An AgentV3 run that proposed a repair (`lib/experience/run-repair.js`)
 * paused with the repair step queued and a pending `huqan.agent_repair`
 * approval. Approving that record lands here, and the run is resumed with no
 * further human step.
 *
 * The approval lifecycle is the approved-`huqan.agent` one, reused as is:
 * the goal is re-checked against the current MCP gate before anything is
 * claimed, the record is claimed (`executing`), the run executes, and the
 * record is finalized with an execution receipt, or failed as
 * outcome-unknown if the run throws. Only the execution differs: instead of
 * a new run, the paused one resumes from its checkpoint and names the
 * approval, which the run itself checks against the stored record.
 *
 * The receipt names the approval's own tool, passed in by the decision
 * handler, so this module needs nothing from the run side.
 *
 * The agent runs on the approval store, which is where the proposing run
 * wrote both its checkpoint and this approval. The store belongs to the
 * approval runtime, so it is not closed here.
 */

const { executeApprovedMcpAgent, createApprovalAgent } = require('./mcp-agent-approval-execution');

function repairArgs(approval) {
  const context = approval && approval.context && typeof approval.context === 'object' ? approval.context : {};
  const args = context.args && typeof context.args === 'object' ? context.args : {};
  return {
    goal: typeof args.goal === 'string' ? args.goal : '',
    workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : '',
    checkpointId: typeof args.checkpointId === 'string' ? args.checkpointId : '',
    resumeToken: typeof args.resumeToken === 'string' ? args.resumeToken : '',
  };
}

function defaultCreateRepairAgent(kernel, approvalStore) {
  return createApprovalAgent(kernel, approvalStore);
}

function executeApprovedRepair({
  kernel, approvalStore, approval, approvalId, workspaceId, reason, decision, fail, tool,
  createRepairAgent = defaultCreateRepairAgent,
}) {
  const args = repairArgs(approval);
  if (!args.goal || !args.checkpointId || !args.resumeToken || args.workspaceId !== workspaceId) {
    return fail('REPAIR_APPROVAL_INVALID', 'The repair approval does not name a checkpoint in this workspace.', { approval, retrySafe: false });
  }
  return executeApprovedMcpAgent({
    kernel,
    approvalStore,
    approval,
    approvalId,
    workspaceId,
    reason,
    decision,
    cleanArgs: { goal: args.goal, workspaceId },
    fail,
    receiptTool: tool,
    executeAgent: () => createRepairAgent(kernel, approvalStore).run(args.goal, {
      workspaceId,
      resume: true,
      checkpointId: args.checkpointId,
      resumeToken: args.resumeToken,
      repairApprovalId: approvalId,
    }),
  });
}

module.exports = { executeApprovedRepair };
