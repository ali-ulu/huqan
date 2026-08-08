'use strict';

/**
 * #422 -- `resolveToolApproval` had no status guard in its UPDATE.
 *
 * Every sibling statement on `tool_approvals` is guarded (`AND status =
 * 'pending'` / `AND status = 'executing'` / `AND status = @expected_status`),
 * but `resolveToolApproval` matched on `id` alone. That made an approval
 * decision re-writable after the fact: a second resolve overwrote a finalized
 * row, and because an unrecognized decision maps to 'pending', it could drag
 * an already approved or rejected approval *backwards* into 'pending'.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AxiomStorage = require('../storage');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-approval-status-guard-'));
  const store = new AxiomStorage({
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

function pendingApproval(overrides = {}) {
  return {
    id: 'approval-422',
    approvalKey: 'http.ingest.external.request-422',
    tool: 'http.ingest',
    input: '{"snapshot":"a"}',
    context: { source: 'external-ingest' },
    policy: { action: 'ingest', approval: 'review' },
    status: 'pending',
    decision: 'review',
    reason: 'external_ingest_requires_review',
    ...overrides,
  };
}

test('#422: a finalized approval cannot be dragged back to pending', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(pendingApproval());

    const approved = store.resolveToolApproval('approval-422', 'approved', 'ok');
    assert.equal(approved.status, 'approved');
    const decidedAt = approved.decided_at ?? approved.decidedAt;

    // An unrecognized decision maps to 'pending' -- this is the regression.
    const after = store.resolveToolApproval('approval-422', 'something-else', 'replay');
    assert.equal(after.status, 'approved', 'status must not regress to pending');
    assert.equal(after.decision, 'approved', 'the original decision must stand');
    assert.equal(after.reason, 'ok', 'the original reason must stand');
    assert.equal(after.decided_at ?? after.decidedAt, decidedAt, 'decided_at must not be rewritten');
  });
});

test('#422: an approved decision cannot be flipped to rejected by a replay', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(pendingApproval({ id: 'approval-422-b' }));
    assert.equal(store.resolveToolApproval('approval-422-b', 'approved', 'first').status, 'approved');

    const flipped = store.resolveToolApproval('approval-422-b', 'rejected', 'second');
    assert.equal(flipped.status, 'approved', 'a finalized approval is one-way');
    assert.equal(flipped.decision, 'approved');
  });
});

test('#422: a rejected decision is equally final', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(pendingApproval({ id: 'approval-422-c' }));
    assert.equal(store.resolveToolApproval('approval-422-c', 'rejected', 'nope').status, 'rejected');

    const flipped = store.resolveToolApproval('approval-422-c', 'approved', 'sneaky');
    assert.equal(flipped.status, 'rejected');
    assert.equal(flipped.decision, 'rejected');
  });
});

test('#422: the first resolve of a pending approval still works', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(pendingApproval({ id: 'approval-422-d' }));
    const resolved = store.resolveToolApproval('approval-422-d', 'approved', 'happy path');
    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.decision, 'approved');
    assert.equal(resolved.reason, 'happy path');
    assert.ok((resolved.decided_at ?? resolved.decidedAt) > 0, 'decided_at is stamped');
  });
});

test('#422: the real claim -> execute -> resolve path still finalizes', { skip: !HAS_SQLITE }, () => {
  // The MCP approval path claims the row into 'executing' before resolving it,
  // so the guard must admit 'executing' as well as 'pending'. Guarding on
  // 'pending' alone silently broke this legitimate finalization.
  withStore((store) => {
    store.saveToolApproval(pendingApproval({ id: 'approval-422-e' }));
    const claim = store.claimToolApprovalWithLease('approval-422-e', { owner: 'worker-1' });
    assert.equal(claim.claimed, true);
    assert.equal(store.getToolApprovalById('approval-422-e').status, 'executing');

    const resolved = store.resolveToolApproval('approval-422-e', 'approved', 'executed');
    assert.equal(resolved.status, 'approved', 'executing -> approved must be allowed');
    assert.equal(resolved.decision, 'approved');
  });
});

test('#422: a failed approval is terminal too', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(pendingApproval({ id: 'approval-422-f' }));
    store.claimToolApprovalWithLease('approval-422-f', { owner: 'worker-1' });
    store.failToolApproval('approval-422-f', 'boom');
    assert.equal(store.getToolApprovalById('approval-422-f').status, 'failed');

    const after = store.resolveToolApproval('approval-422-f', 'approved', 'sneaky');
    assert.equal(after.status, 'failed', 'a failed approval cannot be resolved after the fact');
  });
});

test('#422: unknown ids still return null rather than throwing', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    assert.equal(store.resolveToolApproval('no-such-approval', 'approved', ''), null);
    assert.equal(store.resolveToolApproval('', 'approved', ''), null);
  });
});
