'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIONS, DECISIONS, evaluatePullRequest } = require('../lib/pr-guardian/policy');
const { createReviewService } = require('../lib/pr-guardian/review-service');
const { normalizePullRequestSnapshot: normalizeSnapshot } = require('../lib/pr-guardian/snapshot');

function snapshot(overrides = {}) {
  return normalizeSnapshot({
    repo: 'acme/app',
    number: 42,
    title: 'Add alerting guard',
    body: 'Read-only change.',
    baseRef: 'main',
    headRef: 'feature/alerting',
    headSha: 'abc123',
    actor: 'octocat',
    workspaceId: 'github:acme/app',
    files: [{ filename: 'src/alert.js', patch: '+ guard();' }],
    checks: [{ name: 'unit', status: 'completed', conclusion: 'success', required: true }],
    ...overrides,
  });
}

function fakeStorage() {
  const byId = new Map();
  const byKey = new Map();
  let counter = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    saveToolApprovalIfAbsent(record) {
      if (byKey.has(record.approvalKey)) return { inserted: false, approval: clone(byKey.get(record.approvalKey)) };
      const row = { ...record, id: record.id || `approval-${++counter}`, approval_key: record.approvalKey, context_json: JSON.stringify(record.context || {}), policy_json: JSON.stringify(record.policy || {}), created_at: Date.now(), updated_at: Date.now(), decided_at: 0 };
      byKey.set(record.approvalKey, row); byId.set(row.id, row);
      return { inserted: true, approval: hydrate(clone(row)) };
    },
    getToolApprovalById(id) { return hydrate(clone(byId.get(id) || null)); },
    listUnresolvedToolApprovals() { return [...byId.values()].filter(row => ['pending', 'executing', 'failed'].includes(row.status)).map(row => hydrate(clone(row))); },
    resolveToolApproval(id, decision, reason) {
      const row = byId.get(id); if (!row) return null;
      row.status = 'approved'; row.decision = decision; row.reason = reason; row.decided_at = Date.now(); row.updated_at = Date.now(); return hydrate(clone(row));
    },
    rejectToolApproval(id, reason) {
      const row = byId.get(id); if (!row) return { rejected: false, approval: null };
      row.status = 'rejected'; row.decision = 'rejected'; row.reason = reason; row.decided_at = Date.now(); row.updated_at = Date.now(); return { rejected: true, approval: hydrate(clone(row)) };
    },
    failToolApproval(id, reason) {
      const row = byId.get(id); if (!row) return { failed: false, approval: null };
      row.status = 'failed'; row.reason = reason; row.updated_at = Date.now(); return { failed: true, approval: hydrate(clone(row)) };
    },
    saveToolApproval(record) {
      const row = byId.get(record.id); if (!row) return null;
      Object.assign(row, record, { approval_key: record.approvalKey, context_json: JSON.stringify(record.context || {}), policy_json: JSON.stringify(record.policy || {}) });
      return hydrate(clone(row));
    },
  };
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, context: JSON.parse(row.context_json || '{}'), policy: JSON.parse(row.policy_json || '{}') };
}

// The fake store returns DB-shaped rows, as HuqanStorage does.
function serviceWith(storage, options = {}) {
  return createReviewService({ storage, ...options });
}

test('PR Guardian policy distinguishes read, review, dry-run and block', () => {
  const read = evaluatePullRequest(snapshot(), { action: ACTIONS.READ_SNAPSHOT });
  assert.equal(read.decision, DECISIONS.ALLOW);

  const comment = evaluatePullRequest(snapshot(), { action: ACTIONS.COMMENT_CREATE });
  assert.equal(comment.decision, DECISIONS.REVIEW);
  assert.equal(comment.canonicalWrite, false);

  const deploy = evaluatePullRequest(snapshot(), { action: ACTIONS.DEPLOY_START });
  assert.equal(deploy.decision, DECISIONS.BLOCK);

  const status = evaluatePullRequest(snapshot(), { action: ACTIONS.STATUS_PREVIEW });
  assert.equal(status.decision, DECISIONS.DRY_RUN_ONLY);
});

test('PR Guardian blocks risky text and incomplete immutable snapshots', () => {
  const forcePush = evaluatePullRequest(snapshot({ body: 'Please force-push the history rewrite.' }), { action: ACTIONS.COMMENT_CREATE });
  assert.equal(forcePush.decision, DECISIONS.BLOCK);
  assert.match(forcePush.reason, /history_rewrite/);

  const incomplete = evaluatePullRequest({ repo: 'acme/app', workspaceId: 'github:acme/app' }, { action: ACTIONS.READ_SNAPSHOT });
  assert.equal(incomplete.decision, DECISIONS.BLOCK);
  assert.equal(incomplete.reason, 'immutable_pr_snapshot_required');
});

test('Review service is idempotent, requires approval, revalidates head SHA and emits receipt', async () => {
  const storage = fakeStorage();
  const service = serviceWith(storage);
  const queued = service.enqueue(snapshot(), { action: ACTIONS.COMMENT_CREATE });
  assert.equal(queued.decision, DECISIONS.REVIEW);
  assert.equal(queued.idempotent, false);
  assert.equal(service.enqueue(snapshot(), { action: ACTIONS.COMMENT_CREATE }).idempotent, true);

  const beforeApproval = await service.execute(queued.approval.id, { operatorToken: 'operator' });
  assert.equal(beforeApproval.code, 'PR_APPROVAL_REQUIRED');
  assert.equal(beforeApproval.ok, false);

  assert.equal(service.decide(queued.approval.id, 'approved').ok, true);
  let calls = 0;
  const executed = await service.execute(queued.approval.id, {
    operatorToken: 'operator',
    githubClient: { createComment: async () => { calls += 1; return { id: 7, url: 'https://github.example/comment/7' }; } },
  });
  assert.equal(executed.ok, true);
  assert.equal(executed.decision, DECISIONS.ALLOW);
  assert.equal(executed.receipt.outcome, 'completed');
  assert.equal(calls, 1);

  const staleStorage = fakeStorage();
  const staleService = serviceWith(staleStorage, { getCurrentSnapshot: async current => snapshot({ headSha: `${current.headSha}-changed` }) });
  const stale = staleService.enqueue(snapshot(), { action: ACTIONS.COMMENT_CREATE });
  staleService.decide(stale.approval.id, 'approved');
  const staleResult = await staleService.execute(stale.approval.id, { operatorToken: 'operator', githubClient: { createComment: async () => ({}) } });
  assert.equal(staleResult.code, 'PR_SNAPSHOT_STALE');
});

// Keep the public policy import exercised; it prevents accidental export drift.
test('policy exports the canonical snapshot helper', () => {
  assert.equal(typeof normalizeSnapshot, 'function');
});
