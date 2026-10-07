'use strict';

// Characterization for #2207 Move B: the approved-learn tail moved verbatim
// to lib/mcp-approval-learn-execution.js. This drives it through the real
// decision handler up to the claim conflict, proving the moved code runs.

const assert = require('node:assert/strict');
const test = require('node:test');

const { executeApprovedLearn } = require('../lib/mcp-approval-learn-execution');
const { createMcpApprovalDecisionHandler } = require('../lib/mcp-approval-decision-handler');

const fail = (code, message, extra) => ({ ok: false, error: { code, message }, ...extra });

function pendingLearn() {
  return {
    id: 'a9',
    tool: 'huqan.learn',
    input: JSON.stringify({ text: 'cats are animals' }),
    workspace_id: 'w',
    status: 'pending',
    // A real pending row always carries created_at; without it #3486 now reads
    // the row as an expired legacy row and refuses the approval first.
    created_at: Date.now(),
    context: { workspaceId: 'w', args: { text: 'cats are animals' } },
  };
}

function unclaimableStore(stored) {
  return {
    getToolApprovalById: () => stored,
    claimToolApproval: () => null,
    rejectToolApproval: () => null,
    failToolApproval: () => null,
    finalizeToolApprovalWithReceipt: () => null,
  };
}

test('an approved learn that cannot claim reports a decision conflict', () => {
  const handle = createMcpApprovalDecisionHandler({ failApprovalDecision: fail });
  const result = handle(
    { learn: () => { throw new Error('must not execute without a claim'); } },
    { approvalId: 'a9', workspaceId: 'w', decision: 'approved' },
    { approvalStore: unclaimableStore(pendingLearn()) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'APPROVAL_DECISION_CONFLICT');
  assert.equal(result.approval.id, 'a9');
});

test('executeApprovedLearn is the moved learn tail', () => {
  assert.equal(typeof executeApprovedLearn, 'function');
});
