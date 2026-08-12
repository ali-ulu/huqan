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

module.exports = {
  formatApprovalRecord,
  listPersistentApprovals,
  countPersistentApprovals,
  countUnresolvedApprovals,
};
