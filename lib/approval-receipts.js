const { cloneJson: clone } = require('./json-clone');
const { trimText, nowIso, makeDecisionId } = require('./approval-flow-utils');

function buildAuditEvent(decision, receipt, opts = {}) {
  // Internal-only: buildApprovalDecision calls this after normalizing status
  // to approved/rejected and after materializing a receipt. The old fallback
  // to APPROVAL_REQUESTED/null receipt was unreachable from this function.
  const status = decision.status;
  const eventType = status === 'approved' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED';
  const createdAt = trimText(opts.createdAt, decision.createdAt);

  return {
    eventType,
    eventId: trimText(opts.eventId, makeDecisionId('approval_event', [
      decision.approvalId,
      decision.workspaceId,
      decision.actor,
      status,
      receipt.receiptId,
      createdAt,
    ])),
    approvalId: decision.approvalId,
    workspaceId: decision.workspaceId,
    agentId: decision.agentId,
    actor: decision.actor,
    owner: decision.owner,
    actionType: decision.actionType,
    toolName: decision.toolName,
    decision: status,
    receiptId: receipt.receiptId,
    receiptKind: receipt.receiptKind,
    requestedVerdict: decision.requestedVerdict,
    provenanceId: decision.provenanceId,
    trustPolicyVersion: decision.trustPolicyVersion,
    reason: decision.reason,
    overridesAgentVerdict: Boolean(decision.overridesAgentVerdict),
    createdAt,
    metadata: clone(opts.metadata) || {},
  };
}

function buildReviewedActionReceipt(decision = {}, opts = {}) {
  const createdAt = trimText(opts.createdAt, decision.createdAt || nowIso());
  const receiptId = trimText(opts.receiptId, decision.receiptId || makeDecisionId('apr_receipt', [
    decision.approvalId,
    decision.workspaceId,
    decision.actor,
    'approved',
    createdAt,
  ]));

  return {
    receiptId,
    receiptKind: 'reviewed_action_receipt',
    receiptType: 'reviewed-action',
    status: 'reviewed',
    decision: 'approved',
    actionExecution: 'not_executed',
    actionOutcome: 'not_executed',
    approvalId: trimText(decision.approvalId),
    workspaceId: trimText(decision.workspaceId, 'default') || 'default',
    agentId: trimText(decision.agentId),
    actor: trimText(decision.actor),
    owner: trimText(decision.owner),
    actionType: trimText(decision.actionType),
    toolName: trimText(decision.toolName),
    requestedVerdict: trimText(decision.requestedVerdict, 'review'),
    reason: trimText(decision.reason),
    provenanceId: trimText(decision.provenanceId),
    trustPolicyVersion: trimText(decision.trustPolicyVersion),
    createdAt,
    metadata: clone(opts.metadata) || {},
  };
}

function buildBlockedActionReceipt(decision = {}, opts = {}) {
  const createdAt = trimText(opts.createdAt, decision.createdAt || nowIso());
  const receiptId = trimText(opts.receiptId, decision.receiptId || makeDecisionId('apr_receipt', [
    decision.approvalId,
    decision.workspaceId,
    decision.actor,
    'rejected',
    createdAt,
  ]));

  return {
    receiptId,
    receiptKind: 'blocked_action_receipt',
    receiptType: 'blocked-action',
    status: 'blocked',
    decision: 'rejected',
    actionExecution: 'not_executed',
    actionOutcome: 'not_executed',
    approvalId: trimText(decision.approvalId),
    workspaceId: trimText(decision.workspaceId, 'default') || 'default',
    agentId: trimText(decision.agentId),
    actor: trimText(decision.actor),
    owner: trimText(decision.owner),
    actionType: trimText(decision.actionType),
    toolName: trimText(decision.toolName),
    requestedVerdict: trimText(decision.requestedVerdict, 'review'),
    reason: trimText(decision.reason),
    provenanceId: trimText(decision.provenanceId),
    trustPolicyVersion: trimText(decision.trustPolicyVersion),
    createdAt,
    metadata: clone(opts.metadata) || {},
  };
}

module.exports = {
  buildAuditEvent,
  buildReviewedActionReceipt,
  buildBlockedActionReceipt,
};
