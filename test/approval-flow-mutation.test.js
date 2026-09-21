'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  approveRequest,
  rejectRequest,
  buildApprovalDecision,
  buildReviewedActionReceipt,
  buildBlockedActionReceipt,
} = require('../lib/approval-flow');

const request = {
  approvalId: 'apr_001',
  workspaceId: 'workspace-a',
  agentId: 'agent-1',
  actor: 'agent-1',
  owner: 'owner-1',
  actionType: 'learn',
  toolName: 'huqan.learn',
  actionPayload: { fact: 'alpha' },
  requestedVerdict: 'review',
  riskScore: 42,
  reason: 'needs review',
  provenanceId: 'prov-1',
  trustPolicyVersion: '2026-06',
  status: 'pending',
  createdAt: '2026-06-11T12:00:00.000Z',
};

const decision = {
  approvalId: 'apr_001',
  workspaceId: 'workspace-a',
  agentId: 'agent-1',
  actor: 'agent-1',
  owner: 'owner-1',
  actionType: 'learn',
  toolName: 'huqan.learn',
  requestedVerdict: 'review',
  decisionStatus: 'approved',
  status: 'approved',
  reason: 'needs review',
  provenanceId: 'prov-1',
  trustPolicyVersion: '2026-06',
  receiptId: 'fixed-receipt',
  createdAt: '2026-06-11T12:10:00.000Z',
  actionPayload: { fact: 'alpha' },
  metadata: { source: 'manual' },
};

test('reviewed and blocked receipt builders pin every public field', () => {
  assert.deepEqual(buildReviewedActionReceipt(decision, {
    receiptId: 'fixed-receipt',
    createdAt: decision.createdAt,
    metadata: { source: 'manual' },
  }), {
    receiptId: 'fixed-receipt',
    receiptKind: 'reviewed_action_receipt',
    receiptType: 'reviewed-action',
    status: 'reviewed',
    decision: 'approved',
    actionExecution: 'not_executed',
    actionOutcome: 'not_executed',
    approvalId: 'apr_001',
    workspaceId: 'workspace-a',
    agentId: 'agent-1',
    actor: 'agent-1',
    owner: 'owner-1',
    actionType: 'learn',
    toolName: 'huqan.learn',
    requestedVerdict: 'review',
    reason: 'needs review',
    provenanceId: 'prov-1',
    trustPolicyVersion: '2026-06',
    createdAt: '2026-06-11T12:10:00.000Z',
    metadata: { source: 'manual' },
  });

  assert.deepEqual(buildBlockedActionReceipt({
    ...decision,
    decisionStatus: 'rejected',
    status: 'rejected',
  }, {
    receiptId: 'fixed-receipt',
    createdAt: decision.createdAt,
    metadata: { source: 'manual' },
  }), {
    receiptId: 'fixed-receipt',
    receiptKind: 'blocked_action_receipt',
    receiptType: 'blocked-action',
    status: 'blocked',
    decision: 'rejected',
    actionExecution: 'not_executed',
    actionOutcome: 'not_executed',
    approvalId: 'apr_001',
    workspaceId: 'workspace-a',
    agentId: 'agent-1',
    actor: 'agent-1',
    owner: 'owner-1',
    actionType: 'learn',
    toolName: 'huqan.learn',
    requestedVerdict: 'review',
    reason: 'needs review',
    provenanceId: 'prov-1',
    trustPolicyVersion: '2026-06',
    createdAt: '2026-06-11T12:10:00.000Z',
    metadata: { source: 'manual' },
  });
});

test('receipt builders pin fallback vocabulary', () => {
  const reviewed = buildReviewedActionReceipt({}, {
    receiptId: 'r',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(reviewed.workspaceId, 'default');
  assert.equal(reviewed.requestedVerdict, 'review');
  assert.equal(reviewed.receiptKind, 'reviewed_action_receipt');
  assert.equal(reviewed.receiptType, 'reviewed-action');
  assert.equal(reviewed.status, 'reviewed');
  assert.equal(reviewed.decision, 'approved');

  const blocked = buildBlockedActionReceipt({}, {
    receiptId: 'r',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(blocked.workspaceId, 'default');
  assert.equal(blocked.requestedVerdict, 'review');
  assert.equal(blocked.receiptKind, 'blocked_action_receipt');
  assert.equal(blocked.receiptType, 'blocked-action');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.decision, 'rejected');
});

test('approve/reject decisions pin status, receipt, audit and deterministic id shape', () => {
  const approved = approveRequest(request, {
    actor: 'agent-1',
    createdAt: '2026-06-11T12:10:00.000Z',
    receiptId: 'fixed-receipt',
    eventId: 'fixed-event',
    metadata: { source: 'manual' },
  });
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.errors, []);
  assert.deepEqual(approved.warnings, []);
  assert.equal(approved.decision.decisionStatus, 'approved');
  assert.equal(approved.decision.status, 'approved');
  assert.equal(approved.decision.receiptId, 'fixed-receipt');
  assert.equal(approved.decision.receiptKind, 'reviewed_action_receipt');
  assert.equal(approved.decision.auditEventId, 'fixed-event');
  assert.equal(approved.receipt.receiptKind, 'reviewed_action_receipt');
  assert.equal(approved.auditEvent.eventType, 'APPROVAL_APPROVED');
  assert.equal(approved.auditEvent.eventId, 'fixed-event');
  assert.equal(approved.auditEvent.decision, 'approved');
  assert.equal(approved.auditEvent.receiptId, 'fixed-receipt');
  assert.equal(approved.auditEvent.receiptKind, 'reviewed_action_receipt');
  assert.equal(approved.auditEvent.overridesAgentVerdict, false);
  assert.deepEqual(approved.auditEvent.metadata, { source: 'manual' });

  const rejected = rejectRequest(request, {
    actor: 'agent-1',
    createdAt: '2026-06-11T12:11:00.000Z',
    receiptId: 'fixed-blocked',
    eventId: 'fixed-rejected-event',
  });
  assert.equal(rejected.decision.decisionStatus, 'rejected');
  assert.equal(rejected.decision.status, 'rejected');
  assert.equal(rejected.receipt.receiptKind, 'blocked_action_receipt');
  assert.equal(rejected.auditEvent.eventType, 'APPROVAL_REJECTED');
  assert.equal(rejected.auditEvent.decision, 'rejected');
});

test('approval override warning is exact and only applies to approved block requests', () => {
  const approvedBlock = approveRequest({ ...request, requestedVerdict: 'block' }, {
    actor: 'agent-1',
    createdAt: '2026-06-11T12:10:00.000Z',
  });
  assert.deepEqual(approvedBlock.warnings, [{
    code: 'APPROVAL_OVERRIDES_BLOCK',
    field: 'requestedVerdict',
    message: 'operator approved an action the agent itself flagged as block',
  }]);
  assert.equal(approvedBlock.decision.overridesAgentVerdict, true);
  assert.equal(approvedBlock.auditEvent.overridesAgentVerdict, true);

  const rejectedBlock = rejectRequest({ ...request, requestedVerdict: 'block' }, {
    actor: 'agent-1',
    createdAt: '2026-06-11T12:10:00.000Z',
  });
  assert.deepEqual(rejectedBlock.warnings, []);
  assert.equal(rejectedBlock.decision.overridesAgentVerdict, false);
});

test('decision validation pins unsupported and missing decision states', () => {
  const missing = buildApprovalDecision(request, { actor: 'agent-1', createdAt: '2026-06-11T12:10:00.000Z' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => error.field === 'decisionStatus' && error.message === 'decisionStatus is required'));

  const bad = buildApprovalDecision(request, {
    actor: 'agent-1',
    decisionStatus: 'maybe',
    createdAt: '2026-06-11T12:10:00.000Z',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(error => error.field === 'decisionStatus' && error.message === 'decisionStatus is required'));

  const upper = buildApprovalDecision(request, {
    actor: 'agent-1',
    decisionStatus: ' APPROVED ',
    createdAt: '2026-06-11T12:10:00.000Z',
  });
  assert.equal(upper.ok, true);
  assert.equal(upper.decision.decisionStatus, 'approved');
});

test('generated receipt and event ids are deterministic 128-bit sha256 prefixes', () => {
  const noReceiptId = { ...decision, receiptId: '' };
  const reviewedA = buildReviewedActionReceipt(noReceiptId, { createdAt: decision.createdAt });
  const reviewedB = buildReviewedActionReceipt(noReceiptId, { createdAt: decision.createdAt });
  const blocked = buildBlockedActionReceipt({
    ...noReceiptId,
    decisionStatus: 'rejected',
    status: 'rejected',
  }, { createdAt: decision.createdAt });

  assert.match(reviewedA.receiptId, /^apr_receipt_[a-f0-9]{32}$/);
  assert.equal(reviewedA.receiptId, reviewedB.receiptId);
  assert.notEqual(reviewedA.receiptId, blocked.receiptId);
  assert.deepEqual(reviewedA.metadata, {});
  assert.deepEqual(blocked.metadata, {});

  const approvedA = approveRequest(request, {
    actor: 'agent-1',
    createdAt: '2026-06-11T12:10:00.000Z',
    receiptId: 'fixed-receipt',
  });
  const approvedB = approveRequest(request, {
    actor: 'agent-1',
    createdAt: '2026-06-11T12:10:00.000Z',
    receiptId: 'fixed-receipt',
  });
  const rejected = rejectRequest(request, {
    actor: 'agent-1',
    createdAt: '2026-06-11T12:10:00.000Z',
    receiptId: 'fixed-receipt',
  });

  assert.match(approvedA.auditEvent.eventId, /^approval_event_[a-f0-9]{32}$/);
  assert.equal(approvedA.auditEvent.eventId, approvedB.auditEvent.eventId);
  assert.notEqual(approvedA.auditEvent.eventId, rejected.auditEvent.eventId);
});

test('invalid approval request errors are carried with approvalRequest field prefixes', () => {
  const invalid = buildApprovalDecision({
    ...request,
    actionPayload: null,
  }, {
    actor: 'agent-1',
    decisionStatus: 'approved',
    createdAt: '2026-06-11T12:10:00.000Z',
  });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.decision, null);
  assert.equal(invalid.receipt, null);
  assert.equal(invalid.auditEvent, null);
  assert.ok(invalid.errors.some(error =>
    error.field === 'approvalRequest.actionPayload' &&
    error.message === 'actionPayload is required'
  ));
});


test('mutation sentinels pin validation shape, metadata projection and generated id basis', () => {
  const invalidActor = buildApprovalDecision({ ...request, actor: '' }, {
    actor: '',
    decisionStatus: 'approved',
    createdAt: '2026-06-11T12:10:00.000Z',
  });
  assert.equal(invalidActor.ok, false);
  assert.equal(invalidActor.type, 'approval-decision');
  assert.equal(invalidActor.decision, null);
  assert.equal(invalidActor.receipt, null);
  assert.equal(invalidActor.auditEvent, null);
  assert.ok(invalidActor.errors.some(error =>
    error.code === 'VALIDATION_ERROR' &&
    error.field === 'actor' &&
    error.message === 'actor is required'
  ));

  const projected = approveRequest(request, {
    actor: 'agent-1',
    createdAt: '2026-06-11T12:10:00.000Z',
    receiptId: 'metadata-receipt',
    eventId: 'metadata-event',
    metadata: { source: 'operator', nested: { safe: true } },
  });
  assert.equal(projected.type, 'approval-decision');
  assert.deepEqual(projected.decision.metadata, { source: 'operator', nested: { safe: true } });
  assert.deepEqual(projected.receipt.metadata, { source: 'operator', nested: { safe: true } });
  assert.deepEqual(projected.auditEvent.metadata, { source: 'operator', nested: { safe: true } });

  const crypto = require('node:crypto');
  const createdAt = '2026-06-11T12:10:00.000Z';
  const blocked = buildBlockedActionReceipt({ ...decision, receiptId: '' }, { createdAt });
  const expectedBlockedId = 'apr_receipt_' + crypto
    .createHash('sha256')
    .update(['apr_001', 'workspace-a', 'agent-1', 'rejected', createdAt].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 32);
  assert.equal(blocked.receiptId, expectedBlockedId);

  const reviewed = buildReviewedActionReceipt({ ...decision, receiptId: '' }, { createdAt });
  const expectedReviewedId = 'apr_receipt_' + crypto
    .createHash('sha256')
    .update(['apr_001', 'workspace-a', 'agent-1', 'approved', createdAt].join('|'), 'utf8')
    .digest('hex')
    .slice(0, 32);
  assert.equal(reviewed.receiptId, expectedReviewedId);
  assert.notEqual(reviewed.receiptId, blocked.receiptId);

  const requestReceipt = approveRequest({ ...request, receiptId: 'receipt-from-request' }, {
    actor: 'agent-1',
    createdAt,
  });
  assert.equal(requestReceipt.ok, true);
  assert.equal(requestReceipt.decision.receiptId, 'receipt-from-request');
  assert.equal(requestReceipt.receipt.receiptId, 'receipt-from-request');
});
