'use strict';

/**
 * "Queued for review" is a claim about durable state (#772).
 *
 * saveMcpApproval knowingly returns `persisted: false` when no approval store
 * exists -- and createApprovalStoreFromKernel turns any storage construction
 * error into null -- but dispatchMcpTool labelled the result "Tool call queued
 * for review" either way. The mutation was correctly prevented, so nothing
 * unsafe ran; what was wrong is what the caller was told. A human-review
 * workflow was reported as waiting when no row existed, so the requested
 * action simply disappeared while the product claimed otherwise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { callTool } = require('../mcpServer');
const { saveMcpApproval } = require('../lib/mcp-approval-store');

function mockKernel() {
  const learned = [];
  return {
    learned,
    learn(text) { learned.push(text); return { ok: true, data: { learned: 1 } }; },
    ask() { return { ok: true, data: { answer: 'mock' } }; },
  };
}

const REVIEW_CALL = { name: 'axiom.learn', arguments: { text: 'kedi hayvandir' } };

const BROKEN_STORES = [
  ['no store at all', null],
  ['a store with no save method', {}],
  ['a store whose save throws', { saveToolApproval() { throw new Error('SQLITE_CANTOPEN: unable to open /var/lib/huqan/approvals.db'); } }],
  ['a store that returns nothing', { saveToolApproval() { return null; } }],
];

for (const [label, approvalStore] of BROKEN_STORES) {
  test(`review with ${label} is not reported as queued`, () => {
    const kernel = mockKernel();
    const result = callTool(kernel, REVIEW_CALL, { approvalStore });

    assert.equal(result.ok, false);
    assert.equal(result.gate.decision, 'review');
    assert.ok(!result.message.includes('queued for review'), `"${result.message}" claims a queue that does not exist`);
    assert.equal(result.error.code, 'REVIEW_NOT_PERSISTED');
    assert.equal(result.approval.persisted, false);
    assert.match(result.error.reason, /^approval_store_/);
    // ...and the mutation still did not run.
    assert.deepEqual(kernel.learned, []);
  });
}

test('a storage failure does not leak filesystem or SQLite detail', () => {
  const kernel = mockKernel();
  const result = callTool(kernel, REVIEW_CALL, {
    approvalStore: { saveToolApproval() { throw new Error('SQLITE_CANTOPEN: unable to open /var/lib/huqan/approvals.db'); } },
  });

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SQLITE_CANTOPEN/);
  assert.doesNotMatch(serialized, /\/var\/lib\/huqan/);
  assert.equal(result.error.reason, 'approval_store_write_failed');
});

test('a successful save still reports the approval id and the queued state', () => {
  const saved = [];
  const approvalStore = {
    saveToolApproval(approval) {
      saved.push(approval);
      return { ...approval, created_at: approval.createdAt, updated_at: approval.updatedAt };
    },
  };

  const kernel = mockKernel();
  const result = callTool(kernel, REVIEW_CALL, { approvalStore });

  assert.equal(saved.length, 1);
  assert.equal(result.ok, false, 'a queued call still did not execute');
  assert.ok(result.message.includes('queued for review'));
  assert.equal(result.approval.persisted, true);
  assert.match(result.approval.id, /\S/);
  assert.equal(result.approval.status, 'pending');
  assert.equal(result.error, undefined);
  assert.deepEqual(kernel.learned, []);
});

test('saveMcpApproval names why nothing was persisted', () => {
  const gate = { decision: 'review', reason: 'mutating_requires_review', metadata: {} };

  assert.equal(saveMcpApproval(null, 'axiom.learn', {}, gate).notPersistedReason, 'approval_store_unavailable');
  assert.equal(
    saveMcpApproval({ saveToolApproval() { throw new Error('boom'); } }, 'axiom.learn', {}, gate).notPersistedReason,
    'approval_store_write_failed'
  );
  assert.equal(
    saveMcpApproval({ saveToolApproval() { return undefined; } }, 'axiom.learn', {}, gate).notPersistedReason,
    'approval_store_write_unconfirmed'
  );
  assert.equal(
    saveMcpApproval({ saveToolApproval: (a) => a }, 'axiom.learn', {}, gate).persisted,
    true
  );
});

test('a real storage-backed run persists and reports queued', () => {
  // The end-to-end shape: a store that actually writes gets the claim it earns.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-review-'));
  try {
    const rows = [];
    const approvalStore = {
      saveToolApproval(approval) {
        fs.writeFileSync(path.join(dir, `${approval.id}.json`), JSON.stringify(approval));
        rows.push(approval.id);
        return approval;
      },
    };
    const result = callTool(mockKernel(), REVIEW_CALL, { approvalStore });

    assert.equal(rows.length, 1);
    assert.equal(fs.existsSync(path.join(dir, `${rows[0]}.json`)), true);
    assert.equal(result.approval.id, rows[0]);
    assert.ok(result.message.includes('queued for review'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
