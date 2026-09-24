'use strict';

// #2203: the decision half of the tool approval storage mixin: claim, reject,
// fail, resolve, claim-if-approved and the receipt-bound finalize. Installed on
// HuqanStorage.prototype with tool-approval-methods.js; `this` is the storage.

const { normalizeWorkspaceId } = require('../workspace-id');

class ToolApprovalDecisionMethods {
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

  /**
   * Consume an already-approved row for execution (#1675).
   *
   * claimToolApproval() and claimToolApprovalWithLease() both transition out
   * of 'pending', which is the MCP flow: approve and execute are one step. The
   * PR Guardian is the other shape -- an operator approves now, an executor
   * runs later -- so its row is 'approved' when execution starts, and without
   * this transition it stayed 'approved' throughout, leaving the approval
   * spendable as many times as it was submitted.
   *
   * Two guards, for the two ways the same action runs twice:
   *
   *   - Concurrent: the UPDATE matches on the exact context_json that was
   *     read, so of two executors racing on one approval only one changes a
   *     row. The loser sees claimed:false and must not perform the action.
   *   - Sequential: an approval that already carries an execution claim or a
   *     recorded execution is refused before the UPDATE is attempted, so a
   *     replay after a completed run cannot re-enter 'executing'.
   */
  claimApprovedToolApproval(id, { owner = '', reason = 'approval_execution_claimed', workspaceId = 'default' } = {}) {
    if (!id) return { claimed: false, approval: null, reason: 'missing_id' };
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const existing = this.getToolApprovalById(id, normalizedWorkspaceId);
    if (!existing) return { claimed: false, approval: null, reason: 'not_found' };
    if (existing.status !== 'approved' || existing.decision !== 'approved') {
      return { claimed: false, approval: existing, reason: 'not_approved' };
    }
    if (existing.context?.execution) return { claimed: false, approval: existing, reason: 'already_executed' };
    if (existing.context?.executionClaim) return { claimed: false, approval: existing, reason: 'already_claimed' };

    const now = this._now();
    const context = {
      ...(existing.context || {}),
      executionClaim: { owner: String(owner || 'unknown'), claimedAt: now },
    };
    const result = this._stmts.claimApprovedToolApproval.run({
      id: String(id),
      workspace_id: normalizedWorkspaceId,
      reason: String(reason || ''),
      context_json: JSON.stringify(context),
      expected_context_json: existing.context_json,
      updated_at: now,
    });
    const claimed = Number(result.changes || 0) === 1;
    return {
      claimed,
      approval: this.getToolApprovalById(id, normalizedWorkspaceId),
      reason: claimed ? 'claimed' : 'lost_race',
    };
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
  Object.getOwnPropertyNames(ToolApprovalDecisionMethods.prototype)
    .filter(name => name !== 'constructor')
    .map(name => [name, ToolApprovalDecisionMethods.prototype[name]]),
);
