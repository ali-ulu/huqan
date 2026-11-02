'use strict';

// #4482 -- the approved-learn path is three steps across two stores: claim the
// approval (AxiomStorage), commit the Graph mutation, finalize the approval.
// A crash between the last two leaves committed Graph state and an approval
// row stuck `executing`. H-07's sweep fails every stuck row because the row is
// the only record it reads, so a completed write is reported as an unknown
// outcome and never carries its receipt. Reconciliation consults the durable
// mutation journal, which is the authority that can tell the two apart.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const HuqanStorage = require('../storage');
const { reapStuckLeaselessClaims, reconcileStuckLeaselessClaims } = require('../lib/mcp-approval-store');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4482-reconcile-'));
  const memoryPath = path.join(root, 'memory.json');
  const graph = new Graph({ useSQLite: false, memoryPath });
  graph.load();
  const store = new HuqanStorage({ memoryPath, dbPath: path.join(root, 'memory.db') });
  try {
    return fn({ graph, store });
  } finally {
    try { store.close(); } catch (_) {}
    try { graph.close?.(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function pendingLearnApproval(id) {
  return {
    id,
    approvalKey: `mcp.huqan.learn.${id}`,
    tool: 'huqan.learn',
    input: JSON.stringify({ text: 'reconcile probe', workspaceId: 'default' }),
    context: { source: 'mcp', workspaceId: 'default', args: { text: 'reconcile probe', workspaceId: 'default' } },
    policy: { gate: {} },
    status: 'pending',
    decision: 'review',
    reason: 'reconcile_probe',
    createdAt: Date.now(),
  };
}

// The stored learn result the journal keeps for a committed mutation. The
// receipt id is what finalization attaches to the approval row.
function committedLearnResult(text) {
  return {
    ok: true,
    type: 'learn',
    data: {
      learned: 1,
      text,
      admission: { receipt: { receiptId: 'receipt-4482', workspaceId: 'default' } },
    },
    evidence: [],
    error: null,
    meta: {},
  };
}

// Claim a learn approval and then "die": the row stays `executing` with no
// lease, and the store clock is advanced past the stuck threshold.
function claimAndStrand(store, id) {
  let now = 10_000;
  store._now = () => now;
  store.saveToolApproval(pendingLearnApproval(id));
  assert.equal(store.claimToolApproval(id, 'mcp_approved', 'default').claimed, true);
  assert.equal(store.getToolApprovalById(id, 'default').status, 'executing');
  now = 10_000 + 120_000 + 1;
}

test('#4482: a stuck claim whose mutation committed is finalized from the journal, not failed', { skip: !HAS_SQLITE }, () => {
  withFixture(({ graph, store }) => {
    const id = 'appr-4482-committed';
    graph.runMutationOnce(id, () => committedLearnResult('reconcile probe'));
    claimAndStrand(store, id);

    const reconciled = reconcileStuckLeaselessClaims(store, graph);
    assert.deepEqual(reconciled.finalized, [id]);
    assert.deepEqual(reconciled.failed, []);

    const row = store.getToolApprovalById(id, 'default');
    assert.equal(row.status, 'approved');
    assert.equal(row.decision, 'approved');
    assert.equal(row.reason, 'approval_execution_reconciled_from_journal');
    assert.equal(row.context.receipt.receiptId, 'receipt-4482');
    assert.equal(row.context.executionRefs.receiptId, 'receipt-4482');
  });
});

test('#4482: a stuck claim whose mutation never committed stays fail-closed', { skip: !HAS_SQLITE }, () => {
  withFixture(({ graph, store }) => {
    const id = 'appr-4482-uncommitted';
    claimAndStrand(store, id);

    const reconciled = reconcileStuckLeaselessClaims(store, graph);
    assert.deepEqual(reconciled.finalized, []);
    assert.deepEqual(reconciled.failed, [id]);

    const row = store.getToolApprovalById(id, 'default');
    assert.equal(row.status, 'failed');
    assert.equal(row.decision, 'execution_outcome_unknown');
    assert.equal(row.reason, 'execution_outcome_unknown:stuck_leaseless_execution');
    assert.equal(row.context.receipt, undefined);
  });
});

test('#4482: a committed mutation with no canonical receipt is failed terminal, not left executing', { skip: !HAS_SQLITE }, () => {
  withFixture(({ graph, store }) => {
    const id = 'appr-4482-unmaterialized';
    // A bypass-mode / admission-free learn commits with no receipt at all; the
    // live path fails such a row `receipt_not_materialized`
    // (mcp-approval-learn-execution.js). Recovery must reach the same terminal
    // state instead of leaving it `executing` forever.
    graph.runMutationOnce(id, () => ({ ok: true, type: 'learn', data: { learned: 0 }, meta: {} }));
    claimAndStrand(store, id);

    const reconciled = reconcileStuckLeaselessClaims(store, graph);
    assert.deepEqual(reconciled.finalized, []);
    assert.deepEqual(reconciled.failed, [id]);

    const row = store.getToolApprovalById(id, 'default');
    assert.equal(row.status, 'failed');
    assert.equal(row.reason, 'execution_outcome_unknown:receipt_not_materialized');
    assert.equal(row.context.receipt, undefined);
  });
});

test('#4482: reconciliation is idempotent and never re-drives the mutation', { skip: !HAS_SQLITE }, () => {
  withFixture(({ graph, store }) => {
    const id = 'appr-4482-idempotent';
    let commits = 0;
    graph.runMutationOnce(id, () => { commits += 1; return committedLearnResult('probe'); });
    claimAndStrand(store, id);

    const first = reconcileStuckLeaselessClaims(store, graph);
    assert.deepEqual(first.finalized, [id]);

    // The row is terminal now, so a second pass has nothing to act on and the
    // mutation callback was never entered again.
    const second = reconcileStuckLeaselessClaims(store, graph);
    assert.deepEqual(second.finalized, []);
    assert.deepEqual(second.failed, []);
    assert.equal(commits, 1);
    assert.equal(store.getToolApprovalById(id, 'default').status, 'approved');
  });
});

test('#4482: the reaper reconciles through the journal when the graph is available', { skip: !HAS_SQLITE }, () => {
  withFixture(({ graph, store }) => {
    const id = 'appr-4482-wired';
    graph.runMutationOnce(id, () => committedLearnResult('probe'));
    claimAndStrand(store, id);

    reapStuckLeaselessClaims(store, graph);

    const row = store.getToolApprovalById(id, 'default');
    assert.equal(row.status, 'approved');
    assert.equal(row.context.receipt.receiptId, 'receipt-4482');
  });
});

test('#4482: the stuck lister is read-only and leaves the row executing', { skip: !HAS_SQLITE }, () => {
  withFixture(({ store }) => {
    const id = 'appr-4482-readonly';
    claimAndStrand(store, id);

    const stuck = store.listStuckLeaselessExecutingToolApprovals({});
    assert.deepEqual(stuck.map(a => a.id), [id]);
    // Reading is not recovering: the row is untouched until a caller decides.
    assert.equal(store.getToolApprovalById(id, 'default').status, 'executing');
  });
});

test('#4482: without the read-only lister the H-07 sweep remains the fallback', () => {
  const swept = [];
  const legacyStore = {
    recoverStuckLeaselessToolApprovals: () => { swept.push(1); return []; },
  };
  reapStuckLeaselessClaims(legacyStore, { getCommittedMutationResultByOperation: () => null });
  assert.equal(swept.length, 1);
});

test('#4482: without a graph the reaper falls back to the H-07 sweep', () => {
  const swept = [];
  const store = {
    listStuckLeaselessExecutingToolApprovals: () => { throw new Error('must not be read without a graph'); },
    recoverStuckLeaselessToolApprovals: () => { swept.push(1); return []; },
  };
  reapStuckLeaselessClaims(store, null);
  assert.equal(swept.length, 1);
});
