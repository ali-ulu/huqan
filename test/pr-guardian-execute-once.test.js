'use strict';

/**
 * #1675: an approved PR Guardian action must reach GitHub exactly once.
 *
 * The approval used to stay `approved` for the whole execute() call and after
 * it, so nothing distinguished "approved, not yet run" from "approved, already
 * run". A repeated submit -- an impatient operator, a retried HTTP request, a
 * second worker on the same webhook -- posted the comment again, and comments
 * are not undoable.
 *
 * These tests count the calls that actually reach the GitHub client, which is
 * the only thing that matters: the side effect, not the response shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReviewService } = require('../lib/pr-guardian/review-service');
const { ACTIONS, DECISIONS } = require('../lib/pr-guardian/policy');

function snapshot(overrides = {}) {
  return {
    workspaceId: 'default',
    repo: 'ali-ulu/huqan',
    number: 42,
    headSha: 'a'.repeat(40),
    title: 'Add a guard',
    body: 'Ordinary change.',
    author: 'contributor',
    files: [{ filename: 'src/alert.js', patch: '+ guard();' }],
    checks: [{ name: 'unit', status: 'completed', conclusion: 'success', required: true }],
    ...overrides,
  };
}

/**
 * A store with the same status/context transitions as HuqanStorage, including
 * the compare-and-swap that settles a concurrent claim.
 */
function fakeStorage() {
  const byId = new Map();
  const byKey = new Map();
  let counter = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const hydrate = row => (row ? { ...row, context: JSON.parse(row.context_json || '{}'), policy: JSON.parse(row.policy_json || '{}') } : null);

  return {
    saveToolApprovalIfAbsent(record) {
      if (byKey.has(record.approvalKey)) return { inserted: false, approval: hydrate(clone(byKey.get(record.approvalKey))) };
      const row = {
        ...record,
        id: record.id || `approval-${++counter}`,
        approval_key: record.approvalKey,
        context_json: JSON.stringify(record.context || {}),
        policy_json: JSON.stringify(record.policy || {}),
        created_at: Date.now(),
        updated_at: Date.now(),
        decided_at: 0,
      };
      byKey.set(record.approvalKey, row);
      byId.set(row.id, row);
      return { inserted: true, approval: hydrate(clone(row)) };
    },
    getToolApprovalById(id) { return hydrate(clone(byId.get(id) || null)); },
    listUnresolvedToolApprovals() { return [...byId.values()].map(row => hydrate(clone(row))); },
    resolveToolApproval(id, decision, reason) {
      const row = byId.get(id);
      if (!row) return null;
      row.status = decision === 'approved' ? 'approved' : 'rejected';
      row.decision = decision;
      row.reason = reason;
      row.decided_at = Date.now();
      return hydrate(clone(row));
    },
    claimApprovedToolApproval(id, { owner = '', reason = '' } = {}) {
      const row = byId.get(id);
      if (!row) return { claimed: false, approval: null, reason: 'not_found' };
      const existing = hydrate(clone(row));
      if (existing.status !== 'approved' || existing.decision !== 'approved') return { claimed: false, approval: existing, reason: 'not_approved' };
      if (existing.context?.execution) return { claimed: false, approval: existing, reason: 'already_executed' };
      if (existing.context?.executionClaim) return { claimed: false, approval: existing, reason: 'already_claimed' };
      const context = { ...(existing.context || {}), executionClaim: { owner: String(owner), claimedAt: Date.now() } };
      row.status = 'executing';
      row.reason = reason;
      row.context_json = JSON.stringify(context);
      return { claimed: true, approval: hydrate(clone(row)), reason: 'claimed' };
    },
    finalizeToolApprovalWithReceipt(id, { expectedStatus = 'executing', decision = 'approved', reason = '', receipt = null, contextPatch = null } = {}) {
      const row = byId.get(id);
      if (!row || row.status !== expectedStatus) return { finalized: false, approval: row ? hydrate(clone(row)) : null };
      row.context_json = JSON.stringify({ ...JSON.parse(row.context_json || '{}'), ...(contextPatch || {}), receipt });
      row.status = decision === 'approved' ? 'approved' : 'rejected';
      row.decision = decision;
      row.reason = reason;
      return { finalized: true, approval: hydrate(clone(row)) };
    },
    rejectToolApproval(id, reason) {
      const row = byId.get(id);
      if (!row || row.status !== 'pending') return { rejected: false, approval: row ? hydrate(clone(row)) : null };
      row.status = 'rejected';
      row.decision = 'rejected';
      row.reason = reason;
      return { rejected: true, approval: hydrate(clone(row)) };
    },
    failToolApproval(id, reason) {
      const row = byId.get(id);
      if (!row || row.status !== 'executing') return { failed: false, approval: row ? hydrate(clone(row)) : null };
      row.status = 'failed';
      row.decision = 'execution_outcome_unknown';
      row.reason = reason;
      return { failed: true, approval: hydrate(clone(row)) };
    },
  };
}

function countingClient() {
  const client = {
    calls: 0,
    async createComment() {
      client.calls += 1;
      return { id: client.calls, url: `https://github.example/comment/${client.calls}` };
    },
  };
  return client;
}

function approvedService(storage = fakeStorage()) {
  const service = createReviewService({ storage });
  const queued = service.enqueue(snapshot(), { action: ACTIONS.COMMENT_CREATE });
  service.decide(queued.approval.id, 'approved');
  return { service, storage, id: queued.approval.id };
}

test('a sequential replay does not post a second comment', async () => {
  const { service, storage, id } = approvedService();
  const client = countingClient();

  const first = await service.execute(id, { operatorToken: 'operator', githubClient: client });
  assert.equal(first.ok, true);
  assert.equal(first.receipt.outcome, 'completed');

  const replay = await service.execute(id, { operatorToken: 'operator', githubClient: client });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'PR_ALREADY_EXECUTED');
  assert.equal(client.calls, 1, 'the external side effect must happen once');

  // The completed run is legible afterwards, receipt included.
  const stored = storage.getToolApprovalById(id);
  assert.equal(stored.context.execution.outcome, 'completed');
  assert.equal(stored.context.receipt.receiptId, first.receipt.receiptId);
  assert.equal(replay.receipt.receiptId, first.receipt.receiptId);
});

test('concurrent execution requests collapse to a single external call', async () => {
  const { service, id } = approvedService();
  const client = countingClient();

  const results = await Promise.all(
    Array.from({ length: 6 }, () => service.execute(id, { operatorToken: 'operator', githubClient: client })),
  );

  assert.equal(client.calls, 1, 'only one request may reach GitHub');
  assert.equal(results.filter(result => result.ok === true).length, 1);
  for (const refused of results.filter(result => result.ok !== true)) {
    assert.equal(refused.status, 409);
    assert.ok(['PR_EXECUTION_IN_PROGRESS', 'PR_ALREADY_EXECUTED'].includes(refused.code), refused.code);
  }
});

test('a failed call leaves an explicit failed state and is not silently re-run', async () => {
  const { service, storage, id } = approvedService();
  let calls = 0;
  const failing = {
    async createComment() {
      calls += 1;
      const error = new Error('gateway timeout');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  };

  const failure = await service.execute(id, { operatorToken: 'operator', githubClient: failing });
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'GITHUB_EXECUTOR_FAILED');
  assert.equal(failure.receipt.outcome, 'outcome_unknown');

  const stored = storage.getToolApprovalById(id);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.decision, 'execution_outcome_unknown');

  // The comment may or may not have been posted; retrying blind is exactly
  // the duplicate this guard exists to prevent.
  const retry = await service.execute(id, { operatorToken: 'operator', githubClient: failing });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'PR_APPROVAL_REQUIRED');
  assert.equal(calls, 1);
});

test('refusals before the claim leave the approval spendable', async () => {
  const cases = [
    ['missing operator token', { operatorToken: '', githubClient: countingClient() }, 'PR_OPERATOR_TOKEN_REQUIRED'],
    ['missing GitHub client', { operatorToken: 'operator', githubClient: null }, 'GITHUB_EXECUTOR_UNAVAILABLE'],
    ['preview-only action', { operatorToken: 'operator', githubClient: countingClient(), action: ACTIONS.STATUS_PREVIEW }, 'PR_EXECUTION_DRY_RUN_ONLY'],
  ];

  for (const [label, options, code] of cases) {
    const { service, storage, id } = approvedService();
    const refused = await service.execute(id, options);
    assert.equal(refused.code, code, label);
    assert.equal(storage.getToolApprovalById(id).status, 'approved', `${label}: approval must not be consumed`);

    const client = countingClient();
    const executed = await service.execute(id, { operatorToken: 'operator', githubClient: client });
    assert.equal(executed.ok, true, `${label}: a legitimate execution must still work`);
    assert.equal(client.calls, 1);
  }
});

test('a stale snapshot is refused without consuming the approval', async () => {
  const storage = fakeStorage();
  const service = createReviewService({
    storage,
    getCurrentSnapshot: async current => snapshot({ headSha: `${String(current.headSha).slice(0, 39)}b` }),
  });
  const queued = service.enqueue(snapshot(), { action: ACTIONS.COMMENT_CREATE });
  service.decide(queued.approval.id, 'approved');

  const client = countingClient();
  const stale = await service.execute(queued.approval.id, { operatorToken: 'operator', githubClient: client });
  assert.equal(stale.code, 'PR_SNAPSHOT_STALE');
  assert.equal(stale.decision, DECISIONS.BLOCK);
  assert.equal(client.calls, 0);
  assert.equal(storage.getToolApprovalById(queued.approval.id).status, 'approved');
});

test('a store without an atomic claim fails closed instead of executing', async () => {
  const storage = fakeStorage();
  delete storage.claimApprovedToolApproval;
  const service = createReviewService({ storage });
  const queued = service.enqueue(snapshot(), { action: ACTIONS.COMMENT_CREATE });
  service.decide(queued.approval.id, 'approved');

  const client = countingClient();
  const result = await service.execute(queued.approval.id, { operatorToken: 'operator', githubClient: client });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PR_EXECUTION_CLAIM_UNAVAILABLE');
  assert.equal(client.calls, 0);
});

test('an unapproved or rejected approval is still refused', async () => {
  const storage = fakeStorage();
  const service = createReviewService({ storage });
  const queued = service.enqueue(snapshot(), { action: ACTIONS.COMMENT_CREATE });
  const client = countingClient();

  const pending = await service.execute(queued.approval.id, { operatorToken: 'operator', githubClient: client });
  assert.equal(pending.code, 'PR_APPROVAL_REQUIRED');

  service.decide(queued.approval.id, 'rejected');
  const rejected = await service.execute(queued.approval.id, { operatorToken: 'operator', githubClient: client });
  assert.equal(rejected.code, 'PR_APPROVAL_REQUIRED');
  assert.equal(client.calls, 0);
});
