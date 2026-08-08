'use strict';

/**
 * Regression coverage for #422.
 *
 * `resolveToolApproval`'s UPDATE had no status guard, unlike every sibling
 * transition statement in storage.js. A finalized approval could therefore be
 * resolved again and dragged backwards -- and because an unrecognised decision
 * falls through to `status = 'pending'` with `decided_at = 0`, the regression
 * could go all the way back to pending.
 *
 * The guard allows ('pending', 'executing'), which are the two states the live
 * mcpServer path resolves from; the terminal states are refused.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AxiomStorage = require('../storage');

let HAS_SQLITE = true;
try {
  require.resolve('better-sqlite3');
} catch (_) {
  HAS_SQLITE = false;
}

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-resolve-guard-'));
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

function seedPending(store, id = 'guard-1') {
  const saved = store.saveToolApprovalIfAbsent({
    id,
    approvalKey: `axiom.learn.${id}`,
    tool: 'axiom.learn',
    input: '{"text":"sentinel"}',
    status: 'pending',
  });
  assert.equal(saved.inserted, true);
  return id;
}

test('resolving from pending still works (#422)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const id = seedPending(store);
    const resolved = store.resolveToolApproval(id, 'approved', 'ok');
    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.decision, 'approved');
    assert.ok(resolved.decided_at > 0);
  });
});

test('resolving from executing still works -- the live mcpServer path (#422)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const id = seedPending(store);
    // mcpServer claims first (pending -> executing), executes, then resolves.
    assert.equal(store.claimToolApproval(id).claimed, true);
    assert.equal(store.getToolApprovalById(id).status, 'executing');

    const resolved = store.resolveToolApproval(id, 'approved', 'ok');
    assert.equal(resolved.status, 'approved');
  });
});

test('an approved approval cannot be dragged back to pending (#422)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const id = seedPending(store);
    const approved = store.resolveToolApproval(id, 'approved', 'ok');
    assert.equal(approved.status, 'approved');

    // An unrecognised decision maps to status 'pending' with decided_at 0 --
    // the exact regression #422 describes.
    const after = store.resolveToolApproval(id, 'nonsense', 'attacker');
    assert.equal(after.status, 'approved');
    assert.equal(after.decision, 'approved');
    assert.equal(after.reason, 'ok');
    assert.ok(after.decided_at > 0);
  });
});

test('an approved approval cannot be flipped to rejected (#422)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const id = seedPending(store);
    assert.equal(store.resolveToolApproval(id, 'approved', 'ok').status, 'approved');

    const after = store.resolveToolApproval(id, 'rejected', 'flip');
    assert.equal(after.status, 'approved');
    assert.equal(after.decision, 'approved');
  });
});

test('a rejected approval cannot be flipped to approved (#422)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const id = seedPending(store);
    assert.equal(store.resolveToolApproval(id, 'rejected', 'no').status, 'rejected');

    const after = store.resolveToolApproval(id, 'approved', 'flip');
    assert.equal(after.status, 'rejected');
    assert.equal(after.decision, 'rejected');
  });
});

test('a failed approval is not resolvable without reconciliation (#422)', { skip: !HAS_SQLITE }, () => {
  withStore((store) => {
    const id = seedPending(store);
    assert.equal(store.claimToolApproval(id).claimed, true);
    assert.equal(store.failToolApproval(id, 'execution_outcome_unknown').failed, true);
    assert.equal(store.getToolApprovalById(id).status, 'failed');

    const after = store.resolveToolApproval(id, 'approved', 'papering over');
    assert.equal(after.status, 'failed');
    assert.equal(after.decision, 'execution_outcome_unknown');
  });
});
