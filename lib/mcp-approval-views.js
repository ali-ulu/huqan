'use strict';

/**
 * Read-side views over the approval store.
 *
 * Formatting and counting only: nothing here decides, claims or resolves an
 * approval -- that stays in mcpServer.js next to the gate. Split out because
 * mcpServer.js is over the large-file threshold recorded in
 * scripts/file-size-baseline.json and the ratchet in
 * scripts/check-file-size.js forbids growing it further.
 */

const { parseJsonObject } = require('./json-object');
const { redactSecretValues } = require('./tool-call-gate');

function formatApprovalRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    id: record.id || '',
    approvalKey: record.approval_key || record.approvalKey || '',
    tool: record.tool || '',
    input: record.input || '',
    status: record.status || 'pending',
    decision: record.decision || '',
    reason: record.reason || '',
    createdAt: Number(record.created_at || record.createdAt || 0),
    updatedAt: Number(record.updated_at || record.updatedAt || 0),
    policy: record.policy && typeof record.policy === 'object'
      ? record.policy
      : parseJsonObject(record.policy_json, {}),
    context: record.context && typeof record.context === 'object'
      ? record.context
      : parseJsonObject(record.context_json, {}),
  };
}

function listPersistentApprovals(approvalStore, limit = 50) {
  if (!approvalStore) return [];
  const list = typeof approvalStore.listUnresolvedToolApprovals === 'function'
    ? approvalStore.listUnresolvedToolApprovals(limit)
    : typeof approvalStore.listPendingToolApprovals === 'function'
      ? approvalStore.listPendingToolApprovals(limit)
      : [];
  return list
    .map(formatApprovalRecord)
    .filter(Boolean);
}

function countPersistentApprovals(approvalStore) {
  if (!approvalStore || typeof approvalStore.countPendingToolApprovals !== 'function') return 0;
  return approvalStore.countPendingToolApprovals();
}

function countUnresolvedApprovals(approvalStore) {
  if (!approvalStore || typeof approvalStore.countUnresolvedToolApprovals !== 'function') {
    return countPersistentApprovals(approvalStore);
  }
  return approvalStore.countUnresolvedToolApprovals();
}

function projectApprovalRecord(record) {
  const approval = formatApprovalRecord(record);
  if (!approval) return null;
  const args = approval.context?.args && typeof approval.context.args === 'object'
    ? approval.context.args
    : parseJsonObject(approval.input, {});
  return redactSecretValues({
    id: approval.id,
    approvalKey: approval.approvalKey,
    tool: approval.tool,
    status: approval.status,
    decision: approval.decision || null,
    reason: approval.reason || null,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    claim: args.text || args.statement || args.question || null,
    source: approval.context?.source || args.sourceType || null,
    provenance: approval.context?.provenance || args.provenance || null,
    confidence: approval.context?.confidence ?? args.confidence ?? null,
    context: approval.context || null,
    policy: approval.policy || null,
    conflict: approval.context?.conflict || args.conflict || null,
    diff: approval.context?.diff || args.diff || null,
    receipt: approval.context?.receipt || null,
  });
}

function projectApprovalDecision(result) {
  const data = result?.data || {};
  const executionResult = redactSecretValues(data.result ?? null);
  const storedReceipt = data.approval?.context?.receipt || null;
  return {
    ...result,
    data: {
      approval: projectApprovalRecord(data.approval),
      decision: data.decision || null,
      executed: data.executed === true,
      idempotent: data.idempotent === true,
      result: executionResult,
      receipt: data.receipt ?? executionResult?.receipt ?? executionResult?.data?.receipt ?? storedReceipt,
      refs: data.refs ?? data.approval?.context?.executionRefs ?? null,
      identity: data.identity ?? null,
      oversight: data.oversight ?? null,
    },
  };
}

function formatCliApprovalList(result, args, json = false) {
  const approvals = Array.isArray(result.approvals) ? result.approvals : [];
  const requestedId = args && typeof args === 'object' ? args.approvalId : '';
  if (requestedId) {
    const approval = approvals.find(item => item.id === requestedId);
    if (!approval) throw new Error(`Approval not found: ${requestedId}`);
    const projected = projectApprovalRecord(approval);
    return json ? { ...result, data: { approval: projected } } : JSON.stringify(projected, null, 2);
  }
  if (json) return { ...result, data: {
    pendingCount: result.pendingCount || 0,
    unresolvedCount: result.unresolvedCount || approvals.length,
    approvals: approvals.map(projectApprovalRecord),
  } };
  if (approvals.length === 0) return 'No pending approvals.';
  return `Pending approvals (${result.pendingCount || approvals.length}):\n${approvals.map(item => `${item.id} | ${item.tool} | ${item.reason || 'review'}`).join('\n')}`;
}

function formatCliApprovalDecision(result, fallbackId, json = false) {
  if (json) return projectApprovalDecision(result);
  const data = result.data || {};
  const approvalId = data.approval?.id || fallbackId;
  if (data.idempotent) return `Approval already ${data.decision}: ${approvalId}.`;
  if (data.decision === 'rejected') return `Approval rejected: ${approvalId}.`;
  return `Approval applied: ${approvalId}. The learned fact was written to canonical state.`;
}

module.exports = {
  formatApprovalRecord,
  listPersistentApprovals,
  countPersistentApprovals,
  countUnresolvedApprovals,
  projectApprovalRecord,
  projectApprovalDecision,
  formatCliApprovalList,
  formatCliApprovalDecision,
};
