'use strict';

/**
 * H-07 (#1980) -- the MCP agent/learn execution claim is leaseless.
 *
 * `claimToolApproval` (lib/mcp-agent-approval-execution.js) writes no
 * `executionClaim.leaseExpiresAt`, so `recoverExpiredToolApprovals` skips
 * those rows forever: a crash between claim and finalize leaves the row
 * `executing`, and every retry fails closed with
 * `APPROVAL_EXECUTION_IN_PROGRESS` with no path out.
 *
 * The fix is a sweep, not a claim change: `recoverStuckLeaselessToolApprovals`
 * fails `executing` rows that never received a lease once they are older than
 * `maxAgeMs`, and the MCP decision handler runs it best-effort at entry. The
 * claim UPDATE (`WHERE status = 'pending'`) is untouched, so the double-claim
 * gate (CLAIM1 true / CLAIM2 false) still holds and recovery never
 * re-executes -- a retry after recovery reports
 * `APPROVAL_RECONCILIATION_REQUIRED`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HuqanStorage = require('../storage');
const { createMcpApprovalDecisionHandler } = require('../lib/mcp-approval-decision-handler');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-h07-claim-lease-'));
  const store = new HuqanStorage({
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
  });
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function pendingAgentApproval(id, workspaceId = 'default') {
  return {
    id,
    approvalKey: `mcp.huqan.agent.${id}`,
    tool: 'huqan.agent',
    input: JSON.stringify({ goal: 'h07 probe goal', workspaceId }),
    context: {
      source: 'mcp',
      workspaceId,
      args: { goal: 'h07 probe goal', workspaceId },
    },
    policy: { gate: {} },
    status: 'pending',
    decision: 'review',
    reason: 'h07_probe',
  };
}

function failApprovalDecision(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

test('H-07: the leaseless double-claim gate still holds (CLAIM1 true / CLAIM2 false)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(pendingAgentApproval('agent-h07-claim'));
    const first = store.claimToolApproval('agent-h07-claim', 'agent_claim', 'default');
    assert.equal(first.claimed, true);
    assert.equal(first.approval.status, 'executing');

    const second = store.claimToolApproval('agent-h07-claim', 'agent_claim', 'default');
    assert.equal(second.claimed, false);
    const current = store.getToolApprovalById('agent-h07-claim', 'default');
    assert.equal(current.status, 'executing');
    assert.equal(Number(current.context?.executionClaim?.leaseExpiresAt || 0), 0);
  });
});

test('H-07: claim, simulated death, then sweep recovers the stuck leaseless row', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    let now = 10_000;
    store._now = () => now;
    store.saveToolApproval(pendingAgentApproval('agent-h07-stuck'));
    assert.equal(store.claimToolApproval('agent-h07-stuck', 'agent_claim', 'default').claimed, true);

    // The process "dies" here: no finalize, no fail. The lease sweeper owns
    // only leased rows, so it never touches this one.
    now = 10_000 + 120_000 + 1;
    assert.deepEqual(
      store.recoverExpiredToolApprovals({ tool: 'huqan.agent', now }).map(a => a.id),
      [],
    );

    const recovered = store.recoverStuckLeaselessToolApprovals({ tool: 'huqan.agent', now });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, 'agent-h07-stuck');
    assert.equal(recovered[0].status, 'failed');
    assert.equal(recovered[0].decision, 'execution_outcome_unknown');
    assert.equal(recovered[0].reason, 'execution_outcome_unknown:stuck_leaseless_execution');

    // Terminal: a replay after recovery cannot re-enter `executing`.
    assert.equal(store.claimToolApproval('agent-h07-stuck', 'agent_claim', 'default').claimed, false);
    assert.equal(store.getToolApprovalById('agent-h07-stuck', 'default').status, 'failed');
  });
});

test('H-07: a live leaseless execution is never failed by the sweep', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    let now = 10_000;
    store._now = () => now;
    store.saveToolApproval(pendingAgentApproval('agent-h07-live'));
    assert.equal(store.claimToolApproval('agent-h07-live', 'agent_claim', 'default').claimed, true);

    now = 10_000 + 1_000;
    assert.deepEqual(store.recoverStuckLeaselessToolApprovals({ now }), []);
    assert.equal(store.getToolApprovalById('agent-h07-live', 'default').status, 'executing');
  });
});

test('H-07: leased rows stay owned by the lease sweeper', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    let now = 10_000;
    store._now = () => now;
    store.saveToolApproval({
      ...pendingAgentApproval('agent-h07-leased'),
      approvalKey: 'mcp.huqan.agent.agent-h07-leased',
      tool: 'http.ingest',
    });
    assert.equal(
      store.claimToolApprovalWithLease('agent-h07-leased', { owner: 'worker-a', leaseMs: 1_000 }).claimed,
      true,
    );

    now = 10_000 + 120_000 + 1;
    assert.deepEqual(store.recoverStuckLeaselessToolApprovals({ now }), []);
    assert.equal(store.getToolApprovalById('agent-h07-leased', 'default').status, 'executing');

    const recovered = store.recoverExpiredToolApprovals({ tool: 'http.ingest', now });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'failed');
  });
});

test('H-07: retry is IN_PROGRESS while fresh, RECONCILIATION_REQUIRED once stuck', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    let now = 10_000;
    store._now = () => now;
    const handler = createMcpApprovalDecisionHandler({ failApprovalDecision });
    store.saveToolApproval(pendingAgentApproval('agent-h07-retry'));
    assert.equal(store.claimToolApproval('agent-h07-retry', 'agent_claim', 'default').claimed, true);

    const fresh = handler({}, {
      approvalId: 'agent-h07-retry', workspaceId: 'default', decision: 'approved', reason: 'retry',
    }, { approvalStore: store });
    assert.equal(fresh.error.code, 'APPROVAL_EXECUTION_IN_PROGRESS');
    assert.equal(store.getToolApprovalById('agent-h07-retry', 'default').status, 'executing');

    now = 10_000 + 120_000 + 1;
    const stuck = handler({}, {
      approvalId: 'agent-h07-retry', workspaceId: 'default', decision: 'approved', reason: 'retry',
    }, { approvalStore: store });
    assert.equal(stuck.error.code, 'APPROVAL_RECONCILIATION_REQUIRED');
    const current = store.getToolApprovalById('agent-h07-retry', 'default');
    assert.equal(current.status, 'failed');
    assert.equal(current.reason, 'execution_outcome_unknown:stuck_leaseless_execution');
  });
});

test('H-07: the decision handler sweeps best-effort and tolerates legacy stores', () => {
  const handler = createMcpApprovalDecisionHandler({ failApprovalDecision });
  let sweeps = 0;
  const modernStore = {
    recoverStuckLeaselessToolApprovals: () => { sweeps += 1; return []; },
    getToolApprovalById: () => null,
    claimToolApproval: () => ({ claimed: false, approval: null }),
    rejectToolApproval: () => ({ rejected: false, approval: null }),
    failToolApproval: () => ({ failed: false, approval: null }),
    finalizeToolApprovalWithReceipt: () => ({ finalized: false, approval: null }),
  };
  const outcome = handler({}, {}, { approvalStore: modernStore });
  assert.equal(sweeps, 1);
  assert.equal(outcome.error.code, 'APPROVAL_ID_REQUIRED');

  const throwingStore = {
    ...modernStore,
    recoverStuckLeaselessToolApprovals: () => { throw new Error('sweep_unavailable'); },
  };
  const tolerated = handler({}, {}, { approvalStore: throwingStore });
  assert.equal(tolerated.error.code, 'APPROVAL_ID_REQUIRED');

  const { recoverStuckLeaselessToolApprovals: _dropped, ...legacyStore } = modernStore;
  const legacy = handler({}, {}, { approvalStore: legacyStore });
  assert.equal(legacy.error.code, 'APPROVAL_ID_REQUIRED');
});
