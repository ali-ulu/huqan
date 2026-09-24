'use strict';

// #2203: the lease half of the tool approval storage mixin: leased claims,
// lease renewal and recovery of expired and stuck leaseless executions.
// Installed on HuqanStorage.prototype with tool-approval-methods.js.

const { normalizeWorkspaceId } = require('../workspace-id');

const RECOVERY_PAGE_SIZE = 500;

class ToolApprovalLeaseMethods {
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

  /**
   * Recover `executing` rows that were claimed without a lease (H-07, #1980).
   *
   * The MCP agent/learn claim (`claimToolApproval`) writes no
   * `executionClaim.leaseExpiresAt`, so `recoverExpiredToolApprovals` skips
   * those rows forever: a crash between claim and finalize leaves the row
   * `executing`, and every retry fails closed with
   * `APPROVAL_EXECUTION_IN_PROGRESS`. This walk fails rows that have been
   * `executing` without a lease for at least `maxAgeMs`, moving them to the
   * same terminal `failed` / `execution_outcome_unknown` state the lease
   * sweeper produces -- a retry then reports
   * `APPROVAL_RECONCILIATION_REQUIRED` instead of hanging with no path out.
   *
   * Fail-closed is preserved: the claim UPDATE (`WHERE status = 'pending'`)
   * is untouched, so a second claim still loses, and recovery reuses the
   * compare-and-swap `failExpiredToolApproval` statement, so a live
   * finalization racing the sweep wins and the sweep writes nothing.
   */
  recoverStuckLeaselessToolApprovals({ tool = '', now = this._now(), maxAgeMs = 120_000, reason = 'execution_outcome_unknown:stuck_leaseless_execution' } = {}) {
    const recovered = [];
    const current = Number(now);
    const safeMaxAgeMs = Math.max(1_000, Number(maxAgeMs) || 120_000);
    const cutoff = current - safeMaxAgeMs;
    // Same keyset walk as recoverExpiredToolApprovals (#426): `id` order with
    // a cursor stays stable while recovery rewrites `updated_at`.
    let cursor = '';
    for (;;) {
      const page = this._stmts.listExecutingToolApprovalsAfter.all(cursor, RECOVERY_PAGE_SIZE);
      if (page.length === 0) break;
      cursor = String(page[page.length - 1].id);

      for (const row of page) {
        const approval = this._hydrateToolApproval(row);
        if (tool && approval.tool !== tool) continue;
        // Leased rows belong to recoverExpiredToolApprovals; this walk only
        // owns rows that never received a lease.
        const expiresAt = Number(approval.context?.executionClaim?.leaseExpiresAt || 0);
        if (Number.isFinite(expiresAt) && expiresAt > 0) continue;
        // Age-gated on the claim timestamp: a live execution that simply has
        // not finalized yet must never be failed out from under itself.
        const updatedAt = Number(approval.updated_at);
        if (!Number.isFinite(updatedAt) || updatedAt > cutoff) continue;
        const normalizedWorkspaceId = normalizeWorkspaceId(approval.workspace_id);
        const result = this._stmts.failExpiredToolApproval.run({
          id: String(approval.id),
          workspace_id: normalizedWorkspaceId,
          reason: String(reason || 'execution_outcome_unknown:stuck_leaseless_execution'),
          expected_context_json: approval.context_json,
          decided_at: current,
          updated_at: current,
        });
        if (Number(result.changes || 0) === 1) recovered.push(this.getToolApprovalById(approval.id, normalizedWorkspaceId));
      }

      if (page.length < RECOVERY_PAGE_SIZE) break;
    }
    return recovered;
  }
}

module.exports = Object.fromEntries(
  Object.getOwnPropertyNames(ToolApprovalLeaseMethods.prototype)
    .filter(name => name !== 'constructor')
    .map(name => [name, ToolApprovalLeaseMethods.prototype[name]]),
);
