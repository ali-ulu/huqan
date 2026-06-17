const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_VERDICTS,
  buildApprovalRequest,
} = require('../lib/approval-schema');
const {
  APPROVAL_QUEUE_STATUSES,
  buildApprovalQueueItem,
  enqueueApprovalRequest,
  expireApprovalRequests,
  getApprovalRequest,
  listApprovalRequests,
  updateApprovalRequestStatus,
} = require('../lib/approval-queue');
const {
  APPROVAL_AUDIT_EVENT_TYPES,
  APPROVAL_DECISION_STATUSES,
  APPROVAL_RECEIPT_KINDS,
  approveRequest,
  rejectRequest,
} = require('../lib/approval-flow');
const {
  MEMORY_ADMISSION_DECISIONS,
  MEMORY_ADMISSION_RECEIPT_KINDS,
  buildMemoryAdmissionReceipt,
  buildMemoryAdmissionRequest,
  evaluateMemoryAdmission,
  normalizeMemoryAdmissionDecision,
} = require('../lib/memory-admission-gate');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

function baseApprovalRequest(overrides = {}) {
  return {
    approvalId: 'apr_v3_smoke_001',
    workspaceId: 'default',
    agentId: 'agent_v3_smoke',
    actor: 'agent_v3_smoke',
    owner: 'sonfi',
    actionType: 'memory_write',
    toolName: 'axiom.learn',
    actionPayload: { claim: 'HUQAN judges.' },
    requestedVerdict: 'review',
    riskScore: 25,
    reason: 'v3-core-smoke',
    provenanceId: 'seed:axiom-identity',
    trustPolicyVersion: 'v3-smoke',
    status: 'pending',
    createdAt: '2026-06-12T00:00:00.000Z',
    metadata: { source: 'v3-core-smoke' },
    ...overrides,
  };
}

function baseMemoryAdmissionRequest(overrides = {}) {
  return {
    admissionId: 'madm_v3_smoke_001',
    workspaceId: 'default',
    actor: 'agent_v3_smoke',
    agentId: 'agent_v3_smoke',
    memoryDraftId: 'draft_v3_smoke_001',
    proposedMemory: {
      content: 'Models generate. Agents act. Memory stores. HUQAN judges.',
      metadata: { source: 'v3-core-smoke' },
    },
    provenanceId: 'seed:axiom-identity',
    trustPolicyVersion: 'v3-smoke',
    approvalId: 'apr_v3_smoke_001',
    approvalStatus: 'approved',
    reason: 'v3-core-smoke',
    riskScore: 10,
    createdAt: '2026-06-12T00:00:00.000Z',
    metadata: { source: 'v3-core-smoke' },
    ...overrides,
  };
}

test('V3 Core smoke: status contracts stay stable', () => {
  assert.deepEqual(APPROVAL_REQUEST_STATUSES, ['pending', 'approved', 'rejected', 'expired', 'cancelled']);
  assert.deepEqual(APPROVAL_REQUEST_VERDICTS, ['allow', 'review', 'dry_run_only', 'block']);
  assert.deepEqual(APPROVAL_QUEUE_STATUSES, ['pending', 'approved', 'rejected', 'expired', 'cancelled']);
  assert.deepEqual(APPROVAL_DECISION_STATUSES, ['approved', 'rejected']);
  assert.deepEqual(APPROVAL_RECEIPT_KINDS, ['reviewed_action_receipt', 'blocked_action_receipt']);
  assert.deepEqual(APPROVAL_AUDIT_EVENT_TYPES, ['APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_REJECTED']);
  assert.deepEqual(MEMORY_ADMISSION_DECISIONS, ['allow', 'review', 'reject', 'quarantine']);
  assert.deepEqual(MEMORY_ADMISSION_RECEIPT_KINDS, [
    'memory_admission_receipt',
    'memory_review_receipt',
    'memory_rejection_receipt',
    'memory_quarantine_receipt',
  ]);
});

test('V3 Core smoke: approval request to queue to decision flow', () => {
  const approvalInput = deepFreeze(baseApprovalRequest());
  const approvalBuilt = buildApprovalRequest(approvalInput);
  assert.equal(approvalBuilt.ok, true);
  assert.equal(approvalBuilt.request.status, 'pending');
  assert.equal(approvalBuilt.request.requestedVerdict, 'review');

  const queueBuilt = buildApprovalQueueItem({ approvalRequest: approvalBuilt.request });
  assert.equal(queueBuilt.ok, true);
  assert.equal(queueBuilt.item.status, 'pending');
  assert.equal(queueBuilt.item.approvalRequest.approvalId, approvalBuilt.request.approvalId);

  const queue = enqueueApprovalRequest([], approvalBuilt.request);
  assert.equal(queue.ok, true);
  assert.equal(queue.queue.length, 1);

  const listed = listApprovalRequests(queue.queue, { workspaceId: 'default' });
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 1);
  assert.equal(listed.approvals[0].approvalId, approvalBuilt.request.approvalId);

  const fetched = getApprovalRequest(queue.queue, approvalBuilt.request.approvalId, { workspaceId: 'default' });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.item.approvalId, approvalBuilt.request.approvalId);

  const updated = updateApprovalRequestStatus(queue.queue, approvalBuilt.request.approvalId, 'approved');
  assert.equal(updated.ok, true);
  assert.equal(updated.item.status, 'approved');

  const expired = expireApprovalRequests(
    [
      {
        ...queue.queue[0],
        approvalRequest: {
          ...queue.queue[0].approvalRequest,
          expiresAt: '2026-06-12T00:00:00.000Z',
        },
        expiresAt: '2026-06-12T00:00:00.000Z',
      },
    ],
    { now: '2026-06-12T00:00:01.000Z' },
  );
  assert.equal(expired.expiredCount, 1);
  assert.equal(expired.queue[0].status, 'expired');

  const approvedDecision = approveRequest(approvalBuilt.request);
  assert.equal(approvedDecision.ok, true);
  assert.equal(approvedDecision.decision.status, 'approved');
  assert.equal(approvedDecision.receipt.receiptKind, 'reviewed_action_receipt');
  assert.equal(approvedDecision.receipt.actionExecution, 'not_executed');
  assert.equal(approvedDecision.auditEvent.eventType, 'APPROVAL_APPROVED');

  const rejectedDecision = rejectRequest(approvalBuilt.request);
  assert.equal(rejectedDecision.ok, true);
  assert.equal(rejectedDecision.decision.status, 'rejected');
  assert.equal(rejectedDecision.receipt.receiptKind, 'blocked_action_receipt');
  assert.equal(rejectedDecision.auditEvent.eventType, 'APPROVAL_REJECTED');
});

test('V3 Core smoke: memory admission gate handles allow review reject quarantine', () => {
  const allowInput = deepFreeze(baseMemoryAdmissionRequest());
  const allowBuilt = buildMemoryAdmissionRequest(allowInput);
  assert.equal(allowBuilt.ok, true);
  assert.equal(allowBuilt.request.approvalStatus, 'approved');

  const allowDecision = evaluateMemoryAdmission(allowBuilt.request);
  assert.equal(allowDecision.ok, true);
  assert.equal(allowDecision.decision.decision, 'allow');
  assert.equal(allowDecision.receipt.receiptKind, 'memory_admission_receipt');
  assert.equal(allowDecision.receipt.canonical, true);

  const reviewDecision = evaluateMemoryAdmission(baseMemoryAdmissionRequest({
    provenanceId: '',
    approvalStatus: 'pending',
    approvalId: '',
  }));
  assert.equal(reviewDecision.ok, true);
  assert.equal(reviewDecision.decision.decision, 'review');
  assert.equal(reviewDecision.receipt.receiptKind, 'memory_review_receipt');
  assert.equal(reviewDecision.receipt.reviewed, true);

  const rejectDecision = evaluateMemoryAdmission(baseMemoryAdmissionRequest({
    approvalStatus: 'rejected',
    approvalId: 'apr_v3_reject_001',
  }));
  assert.equal(rejectDecision.ok, true);
  assert.equal(rejectDecision.decision.decision, 'reject');
  assert.equal(rejectDecision.receipt.receiptKind, 'memory_rejection_receipt');
  assert.equal(rejectDecision.receipt.canonical, false);
  assert.equal(rejectDecision.receipt.rejected, true);

  const quarantineDecision = evaluateMemoryAdmission(baseMemoryAdmissionRequest({
    riskScore: 95,
    proposedMemory: {
      status: 'superseded',
      supersedesMemoryId: 'mem_001',
      metadata: { source: 'v3-core-smoke' },
    },
  }));
  assert.equal(quarantineDecision.ok, true);
  assert.equal(quarantineDecision.decision.decision, 'quarantine');
  assert.equal(quarantineDecision.receipt.receiptKind, 'memory_quarantine_receipt');
  assert.equal(quarantineDecision.receipt.quarantined, true);
  assert.equal(quarantineDecision.receipt.canonical, false);
});

test('V3 Core smoke: receipts and decisions stay JSON-safe and immutable', () => {
  const request = baseMemoryAdmissionRequest({
    approvalStatus: 'rejected',
    approvalId: 'apr_v3_reject_immutable',
    riskScore: 70,
  });
  const decision = evaluateMemoryAdmission(request);
  assert.equal(decision.ok, true);
  const normalized = normalizeMemoryAdmissionDecision(decision.decision);
  assert.equal(normalized.ok, true);

  const receipt = buildMemoryAdmissionReceipt(normalized, { metadata: { checked: true } });
  assert.equal(receipt.receiptId.length > 0, true);
  assert.equal(JSON.parse(JSON.stringify(receipt)).receiptKind, receipt.receiptKind);

  const original = deepClone(request);
  assert.deepEqual(request, original);
});
