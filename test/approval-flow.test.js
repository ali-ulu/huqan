const assert = require('assert');
const { describe, test } = require('node:test');

const {
  APPROVAL_AUDIT_EVENT_TYPES,
  APPROVAL_DECISION_STATUSES,
  APPROVAL_RECEIPT_KINDS,
  approveRequest,
  buildApprovalDecision,
  buildBlockedActionReceipt,
  buildReviewedActionReceipt,
  rejectRequest,
} = require('../lib/approval-flow');

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

describe('approval-flow', () => {
  test('status and receipt enums stay stable', () => {
    assert.deepStrictEqual(APPROVAL_DECISION_STATUSES, ['approved', 'rejected']);
    assert.deepStrictEqual(APPROVAL_RECEIPT_KINDS, ['reviewed_action_receipt', 'blocked_action_receipt']);
    assert.deepStrictEqual(APPROVAL_AUDIT_EVENT_TYPES, ['APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_REJECTED']);
  });

  test('buildApprovalDecision rejects missing actor or invalid request cleanly', () => {
    const missingActor = buildApprovalDecision({ ...baseRequest, actor: '' }, { actor: '' });
    assert.strictEqual(missingActor.ok, false);
    assert.ok(missingActor.errors.some((error) => error.field === 'actor'));

    const invalidRequest = buildApprovalDecision({
      ...baseRequest,
      actionPayload: null,
    }, { actor: 'agent-1' });
    assert.strictEqual(invalidRequest.ok, false);
    assert.ok(invalidRequest.errors.some((error) => String(error.field).includes('actionPayload')));
  });

  test('approveRequest returns a reviewed receipt without executing the action', () => {
    const source = clone(baseRequest);
    const result = approveRequest(source, {
      actor: 'agent-1',
      createdAt: '2026-06-11T12:10:00.000Z',
      metadata: { source: 'manual-review' },
    });

    assert.ok(result.ok);
    assert.strictEqual(result.decision.decisionStatus, 'approved');
    assert.strictEqual(result.decision.status, 'approved');
    assert.strictEqual(result.receipt.receiptKind, 'reviewed_action_receipt');
    assert.strictEqual(result.receipt.status, 'reviewed');
    assert.strictEqual(result.receipt.actionExecution, 'not_executed');
    assert.strictEqual(result.receipt.actionOutcome, 'not_executed');
    assert.strictEqual(result.receipt.workspaceId, 'workspace-a');
    assert.strictEqual(result.auditEvent.eventType, 'APPROVAL_APPROVED');
    assert.strictEqual(result.auditEvent.receiptKind, 'reviewed_action_receipt');
    assert.strictEqual(result.auditEvent.workspaceId, 'workspace-a');
    assert.strictEqual(result.auditEvent.actor, 'agent-1');
    assert.deepStrictEqual(source, baseRequest);
  });

  test('rejectRequest returns a blocked receipt without deleting the request', () => {
    const result = rejectRequest(baseRequest, {
      actor: 'agent-1',
      createdAt: '2026-06-11T12:11:00.000Z',
      metadata: { source: 'manual-review' },
    });

    assert.ok(result.ok);
    assert.strictEqual(result.decision.decisionStatus, 'rejected');
    assert.strictEqual(result.receipt.receiptKind, 'blocked_action_receipt');
    assert.strictEqual(result.receipt.status, 'blocked');
    assert.strictEqual(result.receipt.actionExecution, 'not_executed');
    assert.strictEqual(result.auditEvent.eventType, 'APPROVAL_REJECTED');
    assert.strictEqual(result.auditEvent.receiptKind, 'blocked_action_receipt');
    assert.strictEqual(result.auditEvent.workspaceId, 'workspace-a');
  });

  test('receipt builders are deterministic and JSON-safe', () => {
    const decision = {
      approvalId: 'apr_001',
      workspaceId: 'workspace-a',
      agentId: 'agent-1',
      actor: 'agent-1',
      owner: 'owner-1',
      actionType: 'learn',
      toolName: 'axiom.learn',
      requestedVerdict: 'review',
      decisionStatus: 'approved',
      status: 'approved',
      reason: 'needs review',
      provenanceId: 'prov-1',
      trustPolicyVersion: '2026-06',
      receiptId: 'apr_receipt_001',
      createdAt: '2026-06-11T12:10:00.000Z',
      actionPayload: { fact: 'alpha' },
      metadata: { source: 'manual-review' },
    };

    const reviewed = buildReviewedActionReceipt(decision, { createdAt: decision.createdAt, metadata: { source: 'manual-review' } });
    const blocked = buildBlockedActionReceipt({ ...decision, decisionStatus: 'rejected', status: 'rejected' }, { createdAt: '2026-06-11T12:11:00.000Z', metadata: { source: 'manual-review' } });

    assert.strictEqual(JSON.stringify(reviewed).includes('undefined'), false);
    assert.strictEqual(JSON.stringify(blocked).includes('undefined'), false);
    assert.strictEqual(reviewed.receiptKind, 'reviewed_action_receipt');
    assert.strictEqual(blocked.receiptKind, 'blocked_action_receipt');
    assert.strictEqual(reviewed.workspaceId, 'workspace-a');
    assert.strictEqual(blocked.workspaceId, 'workspace-a');
  });
});
