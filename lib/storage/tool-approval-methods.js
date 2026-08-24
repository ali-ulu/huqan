'use strict';

const { normalizeWorkspaceId } = require('../workspace-id');

const RECOVERY_PAGE_SIZE = 500;

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

  claimToolApproval(id, reason = 'approval_execution_claimed', workspaceId = 'default') {
    if (!id) return { claimed: false, approval: null };
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const result = this._stmts.claimToolApproval.run({
      id: String(id),
      workspace_id: normalizedWorkspaceId,
      reason: String(reason || ''),
      updated_at: this._now(),
    });
    return {
      claimed: Number(result.changes || 0) === 1,
      approval: this.getToolApprovalById(id, normalizedWorkspaceId),
    };
  }

  rejectToolApproval(id, reason = 'approval_rejected', workspaceId = 'default') {
    if (!id) return { rejected: false, approval: null };
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const now = this._now();
    const result = this._stmts.rejectToolApproval.run({
      id: String(id),
      workspace_id: normalizedWorkspaceId,
      reason: String(reason || ''),
      decided_at: now,
      updated_at: now,
    });
    return {
      rejected: Number(result.changes || 0) === 1,
      approval: this.getToolApprovalById(id, normalizedWorkspaceId),
    };
  }

  failToolApproval(id, reason = 'approval_execution_failed', workspaceId = 'default') {
    if (!id) return { failed: false, approval: null };
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const now = this._now();
    const result = this._stmts.failToolApproval.run({
      id: String(id),
      workspace_id: normalizedWorkspaceId,
      reason: String(reason || ''),
      decided_at: now,
      updated_at: now,
    });
    return {
      failed: Number(result.changes || 0) === 1,
      approval: this.getToolApprovalById(id, normalizedWorkspaceId),
    };
  }

  resolveToolApproval(id, decision = 'approved', reason = '', workspaceId = 'default') {
    if (!id) return null;
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.getToolApprovalById(id, normalizedWorkspaceId);
    if (!existing) return null;
    const status = decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'pending';
    const now = this._now();
    this._stmts.resolveToolApproval.run({
      id: String(id),
      workspace_id: normalizedWorkspaceId,
      status,
      decision: String(decision || ''),
      reason: String(reason || ''),
      decided_at: status === 'pending' ? 0 : now,
      updated_at: now,
    });
    return this.getToolApprovalById(id, normalizedWorkspaceId);
  }

  claimToolApprovalWithLease(id, {
    owner = '',
    leaseMs = 60_000,
    reason = 'approval_execution_claimed',
    workspaceId = 'default',
  } = {}) {
    if (!id || !String(owner).trim()) return { claimed: false, approval: null };
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.getToolApprovalById(id, normalizedWorkspaceId);
    if (!existing || existing.status !== 'pending') return { claimed: false, approval: existing };
    const now = this._now();
    const safeLeaseMs = Math.max(1_000, Math.min(900_000, Number(leaseMs) || 60_000));
    const context = {
      ...(existing.context || {}),
      executionClaim: {
        owner: String(owner),
        claimedAt: now,
        leaseExpiresAt: now + safeLeaseMs,
      },
    };
    const result = this._stmts.claimToolApprovalWithLease.run({
      id: String(id),
      workspace_id: normalizedWorkspaceId,
      reason: String(reason || ''),
      context_json: JSON.stringify(context),
      updated_at: now,
    });
    return {
      claimed: Number(result.changes || 0) === 1,
      approval: this.getToolApprovalById(id, normalizedWorkspaceId),
    };
  }

  renewToolApprovalLease(id, owner, leaseMs = 60_000, workspaceId = 'default') {
    if (!id || !String(owner).trim()) return { renewed: false, approval: null };
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.getToolApprovalById(id, normalizedWorkspaceId);
    const claim = existing?.context?.executionClaim;
    if (!existing || existing.status !== 'executing' || claim?.owner !== String(owner)) {
      return { renewed: false, approval: existing || null };
    }
    const now = this._now();
    const safeLeaseMs = Math.max(1_000, Math.min(900_000, Number(leaseMs) || 60_000));
    const context = {
      ...(existing.context || {}),
      executionClaim: {
        ...claim,
        leaseExpiresAt: now + safeLeaseMs,
      },
    };
    const result = this._stmts.renewToolApprovalLease.run({
      id: String(id),
      workspace_id: normalizedWorkspaceId,
      context_json: JSON.stringify(context),
      expected_context_json: existing.context_json,
      updated_at: now,
    });
    return {
      renewed: Number(result.changes || 0) === 1,
      approval: this.getToolApprovalById(id, normalizedWorkspaceId),
    };
  }

  recoverExpiredToolApprovals({ tool = '', now = this._now(), reason = 'execution_lease_expired' } = {}) {
    const recovered = [];
    // Walk executing approvals in id order, a page at a time, instead of
    // materialising a single 10k-row result set (#426). The old cap was not
    // just a memory concern: with more than 10k unresolved approvals, the
    // executing rows past the cap were never recovered at all, silently.
    let cursor = '';
    for (;;) {
      const page = this._stmts.listExecutingToolApprovalsAfter.all(cursor, RECOVERY_PAGE_SIZE);
      if (page.length === 0) break;
      // Advance before filtering, so a page of non-expired rows still moves the
      // cursor and the walk terminates.
      cursor = String(page[page.length - 1].id);

      for (const row of page) {
        const approval = this._hydrateToolApproval(row);
        if (tool && approval.tool !== tool) continue;
        const expiresAt = Number(approval.context?.executionClaim?.leaseExpiresAt || 0);
        if (!Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > now) continue;
        const normalizedWorkspaceId = normalizeWorkspaceId(approval.workspace_id);
        const result = this._stmts.failExpiredToolApproval.run({
          id: String(approval.id),
          workspace_id: normalizedWorkspaceId,
          reason: String(reason || 'execution_lease_expired'),
          expected_context_json: approval.context_json,
          decided_at: now,
          updated_at: now,
        });
        if (Number(result.changes || 0) === 1) recovered.push(this.getToolApprovalById(approval.id, normalizedWorkspaceId));
      }

      if (page.length < RECOVERY_PAGE_SIZE) break;
    }
    return recovered;
  }

  finalizeToolApprovalWithReceipt(id, {
    expectedStatus = 'executing', decision = 'approved', reason = '', receipt = null, contextPatch = null,
    workspaceId = 'default',
  } = {}) {
    if (!id || !receipt || typeof receipt !== 'object') return { finalized: false, approval: null };
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.getToolApprovalById(id, normalizedWorkspaceId);
    if (!existing || existing.status !== expectedStatus) return { finalized: false, approval: existing };
    const status = decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : '';
    if (!status) return { finalized: false, approval: existing };
    const now = this._now();
    const context = {
      ...(existing.context || {}),
      ...(contextPatch && typeof contextPatch === 'object' ? contextPatch : {}),
      receipt,
    };
    const result = this._stmts.finalizeToolApprovalWithReceipt.run({
      id: String(id), workspace_id: normalizedWorkspaceId,
      expected_status: String(expectedStatus), status, decision: String(decision),
      reason: String(reason || ''), context_json: JSON.stringify(context), decided_at: now, updated_at: now,
    });
    return {
      finalized: Number(result.changes || 0) === 1,
      approval: this.getToolApprovalById(id, normalizedWorkspaceId),
    };
  }
}

module.exports = Object.fromEntries(
  Object.getOwnPropertyNames(ToolApprovalMethods.prototype)
    .filter(name => name !== 'constructor')
    .map(name => [name, ToolApprovalMethods.prototype[name]]),
);
