'use strict';

const { normalizeWorkspaceId } = require('../workspace-id');

function normalizeGoal(goal) { return String(goal || '').trim(); }
function lower(goal) { return normalizeGoal(goal).toLowerCase(); }
const APPROVAL_KEY_SEPARATOR = '\u001f';
function approvalWorkspaceId(record = {}) { return normalizeWorkspaceId(record.workspaceId ?? record.context?.workspaceId ?? record.context?.snapshot?.workspaceId); }
function scopedApprovalKey(approvalKey, workspaceId) {
  const key = String(approvalKey || '');
  const prefix = `${workspaceId}${APPROVAL_KEY_SEPARATOR}`;
  return key.startsWith(prefix) ? key : `${prefix}${key}`;
}

class ToolApprovalMethods {
  saveToolApproval(record = {}) {
    const id = String(record.id || this._newId('approval'));
    const context = record.context && typeof record.context === 'object' ? record.context : {};
    const workspaceId = approvalWorkspaceId({ ...record, context });
    const approvalKey = scopedApprovalKey(
      record.approvalKey || `${lower(record.tool)}:${lower(record.input)}:${lower(context.goal || '')}:${String(record.policy?.action || '')}`,
      workspaceId,
    );
    const tool = String(record.tool || '');
    const input = String(record.input || '');
    const policy = record.policy && typeof record.policy === 'object' ? record.policy : {};
    const status = String(record.status || 'pending');
    const decision = String(record.decision || '');
    const reason = String(record.reason || '');
    const now = this._now();
    const payload = {
      id,
      approval_key: approvalKey,
      tool,
      input,
      context_json: JSON.stringify(context),
      policy_json: JSON.stringify(policy),
      status,
      decision,
      reason,
      workspace_id: workspaceId,
      created_at: Number(record.createdAt || now),
      updated_at: now,
      decided_at: Number(record.decidedAt || 0),
    };
    this._stmts.upsertToolApproval.run(payload);
    return this.getToolApprovalByKey(approvalKey, workspaceId);
  }

  saveToolApprovalIfAbsent(record = {}) {
    const context = record.context && typeof record.context === 'object' ? record.context : {};
    const workspaceId = approvalWorkspaceId({ ...record, context });
    const id = String(record.id || this._newId('approval'));
    const approvalKey = scopedApprovalKey(
      record.approvalKey || `${lower(record.tool)}:${lower(record.input)}`,
      workspaceId,
    );
    const now = this._now();
    const payload = {
      id,
      approval_key: approvalKey,
      tool: String(record.tool || ''),
      input: String(record.input || ''),
      context_json: JSON.stringify(context),
      policy_json: JSON.stringify(record.policy && typeof record.policy === 'object' ? record.policy : {}),
      status: String(record.status || 'pending'),
      decision: String(record.decision || ''),
      reason: String(record.reason || ''),
      workspace_id: workspaceId,
      created_at: Number(record.createdAt || now),
      updated_at: now,
      decided_at: Number(record.decidedAt || 0),
    };
    const inserted = this._stmts.insertToolApprovalIfAbsent.run(payload).changes === 1;
    return { inserted, approval: this.getToolApprovalByKey(approvalKey, workspaceId) };
  }

  getToolApprovalByKey(approvalKey, workspaceId = 'default') {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const key = scopedApprovalKey(approvalKey, normalizedWorkspaceId);
    const row = this._stmts.getToolApprovalByKey.get(key, normalizedWorkspaceId);
    return row ? this._hydrateToolApproval(row) : null;
  }

  getToolApprovalById(id, workspaceId = 'default') {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const row = this._stmts.getToolApprovalById.get(String(id || ''), normalizedWorkspaceId);
    return row ? this._hydrateToolApproval(row) : null;
  }

  listPendingToolApprovals(limit = 20, workspaceId = 'default') {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const rows = this._stmts.listPendingToolApprovals.all(normalizedWorkspaceId, Math.max(1, Number(limit) || 20));
    return rows.map(row => this._hydrateToolApproval(row));
  }

  countPendingToolApprovals(workspaceId = 'default') {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    return Number(this._stmts.countPendingToolApprovals.get(normalizedWorkspaceId)?.c || 0);
  }

  listUnresolvedToolApprovals(limit = 20, workspaceId = 'default') {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const rows = this._stmts.listUnresolvedToolApprovals.all(normalizedWorkspaceId, Math.max(1, Number(limit) || 20));
    return rows.map(row => this._hydrateToolApproval(row));
  }

  countUnresolvedToolApprovals(workspaceId = 'default') {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    return Number(this._stmts.countUnresolvedToolApprovals.get(normalizedWorkspaceId)?.c || 0);
  }
}

// Decisions live in tool-approval-methods-decide.js, leases and recovery in
// tool-approval-methods-lease.js (#2203); storage.js installs all three halves
// as one mixin, in this order.
module.exports = {
  ...Object.fromEntries(
    Object.getOwnPropertyNames(ToolApprovalMethods.prototype)
      .filter(name => name !== 'constructor')
      .map(name => [name, ToolApprovalMethods.prototype[name]]),
  ),
  ...require('./tool-approval-methods-decide'),
  ...require('./tool-approval-methods-lease'),
};
