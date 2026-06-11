const assert = require('assert');
const { describe, test } = require('node:test');

const {
  APPROVAL_QUEUE_STATUSES,
  buildApprovalQueueItem,
  enqueueApprovalRequest,
  expireApprovalRequests,
  getApprovalRequest,
  listApprovalRequests,
  normalizeApprovalQueueItem,
  updateApprovalRequestStatus,
  validateApprovalQueueItem,
} = require('../lib/approval-queue');

const baseRequest = {
  approvalId: 'apr_001',
  workspaceId: 'workspace-a',
  agentId: 'agent-1',
  actor: 'agent-1',
  owner: 'owner-1',
  actionType: 'learn',
  toolName: 'axiom.learn',
  actionPayload: { fact: 'alpha' },
  requestedVerdict: 'review',
  riskScore: 42,
  reason: 'needs review',
  provenanceId: 'prov-1',
  trustPolicyVersion: '2026-06',
  status: 'pending',
  createdAt: '2026-06-11T12:00:00.000Z',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('approval-queue', () => {
  test('status list mirrors approval request statuses', () => {
    assert.deepStrictEqual(APPROVAL_QUEUE_STATUSES, ['pending', 'approved', 'rejected', 'expired', 'cancelled']);
  });

  test('normalizeApprovalQueueItem keeps source immutable and defaults queue metadata', () => {
    const source = { approvalRequest: clone(baseRequest), metadata: { source: 'demo' } };
    const normalized = normalizeApprovalQueueItem(source, { workspaceId: 'workspace-a' });

    assert.strictEqual(normalized.approvalId, 'apr_001');
    assert.strictEqual(normalized.workspaceId, 'workspace-a');
    assert.strictEqual(normalized.status, 'pending');
    assert.strictEqual(normalized.approvalRequest.approvalId, baseRequest.approvalId);
    assert.strictEqual(normalized.approvalRequest.workspaceId, baseRequest.workspaceId);
    assert.strictEqual(normalized.approvalRequest.status, baseRequest.status);
    assert.strictEqual(normalized.approvalRequest.receiptId, '');
    assert.strictEqual(normalized.approvalRequest.expiresAt, '');
    assert.deepStrictEqual(source, { approvalRequest: clone(baseRequest), metadata: { source: 'demo' } });
  });

  test('buildApprovalQueueItem produces a pending queue item with timestamps', () => {
    const built = buildApprovalQueueItem({ approvalRequest: baseRequest }, { now: '2026-06-11T12:30:00.000Z' });

    assert.ok(built.ok);
    assert.strictEqual(built.item.status, 'pending');
    assert.strictEqual(built.item.queuedAt, '2026-06-11T12:30:00.000Z');
    assert.strictEqual(built.item.updatedAt, '2026-06-11T12:30:00.000Z');
    assert.strictEqual(built.item.approvalRequest.status, 'pending');
    assert.strictEqual(built.item.approvalRequest.approvalId, 'apr_001');
  });

  test('validateApprovalQueueItem rejects non-pending or malformed queue items', () => {
    const invalidStatus = validateApprovalQueueItem({
      approvalRequest: baseRequest,
      approvalId: 'apr_001',
      workspaceId: 'workspace-a',
      status: 'approved',
      queuedAt: '2026-06-11T12:00:00.000Z',
      updatedAt: '2026-06-11T12:00:00.000Z',
    });

    assert.strictEqual(invalidStatus.ok, false);
    assert.ok(invalidStatus.errors.some((error) => error.field === 'status'));

    const invalidPayload = validateApprovalQueueItem({
      approvalRequest: {
        ...baseRequest,
        actionPayload: null,
      },
      approvalId: 'apr_001',
      workspaceId: 'workspace-a',
      status: 'pending',
      queuedAt: '2026-06-11T12:00:00.000Z',
      updatedAt: '2026-06-11T12:00:00.000Z',
    });

    assert.strictEqual(invalidPayload.ok, false);
    assert.ok(invalidPayload.errors.some((error) => String(error.field).includes('actionPayload')));
  });

  test('enqueueApprovalRequest inserts a pending request and keeps deterministic order', () => {
    const queue = [
      {
        approvalId: 'apr_zz',
        workspaceId: 'workspace-a',
        status: 'pending',
        queuedAt: '2026-06-11T12:05:00.000Z',
        updatedAt: '2026-06-11T12:05:00.000Z',
        approvalRequest: { ...baseRequest, approvalId: 'apr_zz', createdAt: '2026-06-11T12:05:00.000Z' },
      },
    ];

    const result = enqueueApprovalRequest(queue, baseRequest, { now: '2026-06-11T12:01:00.000Z' });

    assert.ok(result.ok);
    assert.strictEqual(result.queue.length, 2);
    assert.strictEqual(result.queue[0].approvalId, 'apr_001');
    assert.strictEqual(result.queue[1].approvalId, 'apr_zz');
    assert.deepStrictEqual(queue[0].approvalId, 'apr_zz');
  });

  test('enqueueApprovalRequest rejects duplicate ids and non-pending requests', () => {
    const duplicate = enqueueApprovalRequest([
      {
        approvalId: 'apr_001',
        workspaceId: 'workspace-a',
        status: 'pending',
        queuedAt: '2026-06-11T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
        approvalRequest: clone(baseRequest),
      },
    ], baseRequest, { now: '2026-06-11T12:01:00.000Z' });

    assert.strictEqual(duplicate.ok, false);
    assert.ok(duplicate.errors.some((error) => error.code === 'DUPLICATE_APPROVAL_ID'));

    const rejectedStatus = enqueueApprovalRequest([], { ...baseRequest, status: 'approved' }, { now: '2026-06-11T12:01:00.000Z' });
    assert.strictEqual(rejectedStatus.ok, false);
    assert.ok(rejectedStatus.errors.some((error) => error.code === 'INVALID_APPROVAL_REQUEST' || error.field === 'status'));
  });

  test('list/get scope by workspace and keep sort order stable', () => {
    const queue = [
      {
        approvalId: 'apr_b',
        workspaceId: 'workspace-b',
        status: 'pending',
        queuedAt: '2026-06-11T12:03:00.000Z',
        updatedAt: '2026-06-11T12:03:00.000Z',
        approvalRequest: { ...baseRequest, approvalId: 'apr_b', workspaceId: 'workspace-b', createdAt: '2026-06-11T12:03:00.000Z' },
      },
      {
        approvalId: 'apr_a',
        workspaceId: 'workspace-a',
        status: 'pending',
        queuedAt: '2026-06-11T12:01:00.000Z',
        updatedAt: '2026-06-11T12:01:00.000Z',
        approvalRequest: { ...baseRequest, approvalId: 'apr_a', workspaceId: 'workspace-a', createdAt: '2026-06-11T12:01:00.000Z' },
      },
      {
        approvalId: 'apr_c',
        workspaceId: 'workspace-a',
        status: 'pending',
        queuedAt: '2026-06-11T12:02:00.000Z',
        updatedAt: '2026-06-11T12:02:00.000Z',
        approvalRequest: { ...baseRequest, approvalId: 'apr_c', workspaceId: 'workspace-a', createdAt: '2026-06-11T12:02:00.000Z' },
      },
    ];

    const listed = listApprovalRequests(queue, { workspaceId: 'workspace-a' });
    assert.strictEqual(listed.count, 2);
    assert.deepStrictEqual(listed.approvals.map((item) => item.approvalId), ['apr_a', 'apr_c']);

    const found = getApprovalRequest(queue, 'apr_c', { workspaceId: 'workspace-a' });
    assert.ok(found.ok);
    assert.strictEqual(found.item.approvalId, 'apr_c');

    const notFound = getApprovalRequest(queue, 'apr_b', { workspaceId: 'workspace-a' });
    assert.strictEqual(notFound.ok, false);
    assert.ok(notFound.errors.some((error) => error.code === 'APPROVAL_NOT_FOUND'));
  });

  test('updateApprovalRequestStatus updates the queue item and blocks invalid transitions', () => {
    const queue = [
      {
        approvalId: 'apr_001',
        workspaceId: 'workspace-a',
        status: 'pending',
        queuedAt: '2026-06-11T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
        approvalRequest: clone(baseRequest),
      },
    ];

    const approved = updateApprovalRequestStatus(queue, 'apr_001', 'approved', { workspaceId: 'workspace-a', updatedAt: '2026-06-11T12:10:00.000Z' });
    assert.ok(approved.ok);
    assert.strictEqual(approved.item.status, 'approved');
    assert.strictEqual(approved.item.approvalRequest.status, 'approved');
    assert.strictEqual(approved.queue[0].status, 'approved');
    assert.deepStrictEqual(queue[0].status, 'pending');

    const blocked = updateApprovalRequestStatus(approved.queue, 'apr_001', 'rejected', { workspaceId: 'workspace-a' });
    assert.strictEqual(blocked.ok, false);
    assert.ok(blocked.errors.some((error) => error.code === 'INVALID_STATUS_TRANSITION'));
  });

  test('expireApprovalRequests expires only pending items with lapsed timestamps', () => {
    const queue = [
      {
        approvalId: 'apr_001',
        workspaceId: 'workspace-a',
        status: 'pending',
        queuedAt: '2026-06-11T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
        expiresAt: '2026-06-11T12:05:00.000Z',
        approvalRequest: { ...baseRequest, expiresAt: '2026-06-11T12:05:00.000Z' },
      },
      {
        approvalId: 'apr_002',
        workspaceId: 'workspace-a',
        status: 'approved',
        queuedAt: '2026-06-11T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
        approvalRequest: { ...baseRequest, approvalId: 'apr_002', status: 'approved' },
      },
    ];

    const expired = expireApprovalRequests(queue, { now: '2026-06-11T12:10:00.000Z' });
    assert.ok(expired.ok);
    assert.strictEqual(expired.expiredCount, 1);
    assert.strictEqual(expired.queue[0].status, 'expired');
    assert.strictEqual(expired.queue[0].approvalRequest.status, 'expired');
    assert.strictEqual(expired.queue[1].status, 'approved');
  });
});
