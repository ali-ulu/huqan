const { buildApprovalRequest } = require('./approval-schema');
const { isPlainObject } = require('./is-plain-object');
const { cloneJson: clone } = require('./json-clone');
const {
  APPROVAL_DECISION_STATUSES,
  trimText,
  nowIso,
  pushError,
  normalizeDecisionStatus,
} = require('./approval-flow-utils');
const {
  buildAuditEvent,
  buildReviewedActionReceipt,
  buildBlockedActionReceipt,
} = require('./approval-receipts');

const APPROVAL_RECEIPT_KINDS = Object.freeze([
  'reviewed_action_receipt',
  'blocked_action_receipt',
]);

const APPROVAL_AUDIT_EVENT_TYPES = Object.freeze([
  'APPROVAL_REQUESTED',
  'APPROVAL_APPROVED',
  'APPROVAL_REJECTED',
]);

function normalizeDecisionInput(approvalRequest = {}, opts = {}) {
  const source = isPlainObject(approvalRequest) ? approvalRequest : {};
  const requestResult = buildApprovalRequest(source, opts);
  const request = requestResult.request;
  const actor = trimText(opts.actor, trimText(request.actor, ''));
  const decisionStatus = normalizeDecisionStatus(opts.decisionStatus ?? opts.status ?? opts.verdict ?? opts.decision);
  const createdAt = trimText(opts.createdAt, nowIso());

  const normalized = {
    approvalId: trimText(request.approvalId),
    workspaceId: trimText(request.workspaceId, 'default') || 'default',
    agentId: trimText(request.agentId),
    actor,
    owner: trimText(request.owner),
    actionType: trimText(request.actionType),
    toolName: trimText(request.toolName),
    requestedVerdict: trimText(request.requestedVerdict, 'review'),
    reason: trimText(request.reason),
    provenanceId: trimText(request.provenanceId),
    trustPolicyVersion: trimText(request.trustPolicyVersion),
    receiptId: trimText(opts.receiptId, trimText(request.receiptId, '')),
    createdAt,
    actionPayload: clone(request.actionPayload),
    metadata: clone(opts.metadata) || {},
    decisionStatus,
    request,
    requestValidation: requestResult,
  };

  return normalized;
}

function validateDecision(normalized) {
  const errors = [];
  const warnings = [];

  // normalizeDecisionInput always gets this object from buildApprovalRequest().
  // That boundary already validates/generates approvalId and workspaceId and
  // validates/clones actionPayload. Re-validating those fields here created
  // unreachable branches that mutation testing correctly exposed.
  if (!normalized.requestValidation.ok) {
    for (const error of normalized.requestValidation.errors) {
      errors.push({
        ...error,
        field: error.field ? `approvalRequest.${error.field}` : 'approvalRequest',
      });
    }
  }

  // Keep the top-level actor error because callers of this decision boundary
  // historically receive it in addition to the request-scoped validation.
  if (!trimText(normalized.actor)) {
    pushError(errors, 'actor', 'actor is required');
  }

  // normalizeDecisionStatus returns only approved/rejected or ''. There is no
  // separate reachable "unsupported but non-empty" state to validate twice.
  if (!normalized.decisionStatus) {
    pushError(errors, 'decisionStatus', 'decisionStatus is required');
  }

  // ASI09: surface when an operator overrides the agent's own safety judgment,
  // so a human approving an agent-flagged block becomes auditable.
  if (normalized.decisionStatus === 'approved' && normalized.requestedVerdict === 'block') {
    warnings.push({
      code: 'APPROVAL_OVERRIDES_BLOCK',
      field: 'requestedVerdict',
      message: 'operator approved an action the agent itself flagged as block',
    });
  }

  return { ok: errors.length === 0, type: 'approval-decision', warnings, errors };
}

function buildApprovalDecision(approvalRequest = {}, opts = {}) {
  const normalized = normalizeDecisionInput(approvalRequest, opts);
  const validation = validateDecision(normalized);
  if (!validation.ok) {
    return {
      ok: false,
      type: 'approval-decision',
      warnings: validation.warnings,
      errors: validation.errors,
      decision: null,
      receipt: null,
      auditEvent: null,
      approvalRequest: normalized.request,
    };
  }

  const decision = {
    approvalId: normalized.approvalId,
    workspaceId: normalized.workspaceId,
    agentId: normalized.agentId,
    actor: normalized.actor,
    owner: normalized.owner,
    actionType: normalized.actionType,
    toolName: normalized.toolName,
    requestedVerdict: normalized.requestedVerdict,
    decisionStatus: normalized.decisionStatus,
    status: normalized.decisionStatus,
    reason: normalized.reason,
    overridesAgentVerdict: normalized.decisionStatus === 'approved' && normalized.requestedVerdict === 'block',
    provenanceId: normalized.provenanceId,
    trustPolicyVersion: normalized.trustPolicyVersion,
    receiptId: normalized.receiptId || '',
    createdAt: normalized.createdAt,
    actionPayload: clone(normalized.actionPayload),
    metadata: clone(normalized.metadata) || {},
    approvalRequest: clone(normalized.request),
  };

  const receipt = normalized.decisionStatus === 'approved'
    ? buildReviewedActionReceipt(decision, opts)
    : buildBlockedActionReceipt(decision, opts);
  const auditEvent = buildAuditEvent(decision, receipt, opts);

  decision.receiptId = receipt.receiptId;
  decision.receiptKind = receipt.receiptKind;
  decision.auditEventId = auditEvent.eventId;

  return {
    ok: true,
    type: 'approval-decision',
    warnings: validation.warnings,
    errors: [],
    decision,
    receipt,
    auditEvent,
    approvalRequest: clone(normalized.request),
  };
}

function approveRequest(approvalRequest = {}, opts = {}) {
  return buildApprovalDecision(approvalRequest, {
    ...opts,
    decisionStatus: 'approved',
  });
}

function rejectRequest(approvalRequest = {}, opts = {}) {
  return buildApprovalDecision(approvalRequest, {
    ...opts,
    decisionStatus: 'rejected',
  });
}

module.exports = {
  APPROVAL_AUDIT_EVENT_TYPES,
  APPROVAL_DECISION_STATUSES,
  APPROVAL_RECEIPT_KINDS,
  approveRequest,
  buildApprovalDecision,
  buildBlockedActionReceipt,
  buildReviewedActionReceipt,
  rejectRequest,
};
