'use strict';

// #3878: the SQLite approval store finalizes an executing row as `cancelled`,
// and refuses every finalization it cannot attribute -- no id or receipt, an
// unknown row, a row in another state, or a decision outside the three it
// records. Each refusal must leave the row as it was.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HuqanStorage = require('../storage');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-finalize-cancelled-'));
  const store = new HuqanStorage({ memoryPath: path.join(root, 'memory.json'), dbPath: path.join(root, 'memory.db') });
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function executingRow(store, id) {
  store.saveToolApproval({
    id,
    approvalKey: `mcp.huqan.agent.${id}`,
    tool: 'huqan.agent',
    input: JSON.stringify({ goal: 'finalize probe' }),
    context: { source: 'mcp', workspaceId: 'default', args: { goal: 'finalize probe' } },
    policy: { gate: {} },
    status: 'pending',
    decision: 'review',
    reason: 'finalize_probe',
    createdAt: Date.now(),
  });
  assert.equal(store.claimToolApproval(id, 'agent_claim', 'default').claimed, true);
}

const RECEIPT = Object.freeze({ receiptId: 'r-1', outcome: 'cancelled' });

test('an executing row finalizes as cancelled with its receipt', { skip: !HAS_SQLITE }, () => withStore((store) => {
  executingRow(store, 'fin-cancel');
  const result = store.finalizeToolApprovalWithReceipt('fin-cancel', {
    decision: 'cancelled', reason: 'emergency_stop', receipt: RECEIPT, contextPatch: { executionRefs: { runId: 'run-1' } },
  });

  assert.equal(result.finalized, true);
  assert.equal(result.approval.status, 'cancelled');
  assert.equal(result.approval.context.receipt.receiptId, 'r-1');
  assert.equal(result.approval.context.executionRefs.runId, 'run-1');
  assert.equal(store.countUnresolvedToolApprovals('default'), 0, 'cancelled is terminal, not unresolved');
}));

test('a finalization that cannot be attributed changes nothing', { skip: !HAS_SQLITE }, () => withStore((store) => {
  executingRow(store, 'fin-refuse');

  assert.deepEqual(store.finalizeToolApprovalWithReceipt('', { receipt: RECEIPT }), { finalized: false, approval: null });
  assert.deepEqual(store.finalizeToolApprovalWithReceipt('fin-refuse', { receipt: null }), { finalized: false, approval: null });
  assert.equal(store.finalizeToolApprovalWithReceipt('fin-missing', { receipt: RECEIPT }).approval, null);

  const wrongState = store.finalizeToolApprovalWithReceipt('fin-refuse', { expectedStatus: 'pending', receipt: RECEIPT });
  assert.equal(wrongState.finalized, false);
  assert.equal(wrongState.approval.status, 'executing');

  const unknownDecision = store.finalizeToolApprovalWithReceipt('fin-refuse', { decision: 'paused', receipt: RECEIPT, contextPatch: 'not-an-object' });
  assert.equal(unknownDecision.finalized, false);
  assert.equal(unknownDecision.approval.status, 'executing');
  assert.equal(store.getToolApprovalById('fin-refuse', 'default').context.receipt, undefined);
}));
