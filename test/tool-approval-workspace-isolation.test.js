'use strict';

/**
 * #1210 -- tool approvals must be scoped by workspace at the durable boundary.
 *
 * Workspace identity used to exist only in context_json while every key, id,
 * list, count and state transition query ignored it. That let two tenants with
 * the same approval key share one row, and let a decision for one tenant act
 * on another tenant's approval.
 */

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-approval-workspace-'));
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

function approval(id, workspaceId, overrides = {}) {
  return {
    id,
    approvalKey: 'same-request',
    tool: 'http.ingest',
    input: '{}',
    context: { workspaceId },
    status: 'pending',
    decision: 'review',
    ...overrides,
  };
}

test('#1210: identical approval keys are isolated by workspace', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const a = store.saveToolApprovalIfAbsent(approval('approval-team-a', 'team-a'));
    const b = store.saveToolApprovalIfAbsent(approval('approval-team-b', 'team-b'));

    assert.equal(a.inserted, true);
    assert.equal(b.inserted, true);
    assert.notEqual(a.approval.id, b.approval.id);
    assert.equal(a.approval.workspace_id, 'team-a');
    assert.equal(b.approval.workspace_id, 'team-b');
    assert.notEqual(a.approval.approval_key, b.approval.approval_key);

    assert.equal(store.saveToolApprovalIfAbsent(approval('replay-a', 'team-a')).inserted, false);
    assert.equal(store.saveToolApprovalIfAbsent(approval('replay-b', 'team-b')).inserted, false);
    assert.equal(store.getToolApprovalByKey('same-request', 'team-a').id, 'approval-team-a');
    assert.equal(store.getToolApprovalByKey('same-request', 'team-b').id, 'approval-team-b');
  });
});

test('#1210: reads and decisions cannot cross workspace boundaries', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    store.saveToolApproval(approval('approval-team-a', 'team-a'));
    store.saveToolApproval(approval('approval-team-b', 'team-b'));

    assert.equal(store.getToolApprovalById('approval-team-a', 'team-b'), null);
    assert.equal(store.listPendingToolApprovals(20, 'team-a').map(item => item.id).join(','), 'approval-team-a');
    assert.equal(store.listPendingToolApprovals(20, 'team-b').map(item => item.id).join(','), 'approval-team-b');
    assert.equal(store.countPendingToolApprovals('team-a'), 1);
    assert.equal(store.countPendingToolApprovals('team-b'), 1);
    assert.equal(store.countUnresolvedToolApprovals('team-a'), 1);
    assert.equal(store.countUnresolvedToolApprovals('team-b'), 1);

    assert.equal(store.claimToolApproval('approval-team-a', 'wrong-tenant', 'team-b').claimed, false);
    assert.equal(store.getToolApprovalById('approval-team-a', 'team-a').status, 'pending');

    assert.equal(store.claimToolApproval('approval-team-a', 'team-a-claim', 'team-a').claimed, true);
    assert.equal(store.getToolApprovalById('approval-team-a', 'team-a').status, 'executing');
    assert.equal(store.resolveToolApproval('approval-team-a', 'approved', 'wrong-tenant', 'team-b'), null);
    assert.equal(store.getToolApprovalById('approval-team-a', 'team-a').status, 'executing');
    assert.equal(store.resolveToolApproval('approval-team-a', 'approved', 'team-a-approved', 'team-a').status, 'approved');
    assert.equal(store.getToolApprovalById('approval-team-b', 'team-b').status, 'pending');
  });
});

test('#1210: approval schema exposes a durable workspace column', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const columns = store.db.prepare('PRAGMA table_info(tool_approvals)').all().map(column => column.name);
    assert.ok(columns.includes('workspace_id'));
    store.saveToolApproval({
      id: 'legacy-shaped',
      approvalKey: 'legacy-key',
      tool: 'http.ingest',
      input: '{}',
      context: { snapshot: { workspaceId: 'legacy-team' } },
    });
    assert.equal(store.getToolApprovalById('legacy-shaped', 'legacy-team').workspace_id, 'legacy-team');
  });
});
